/**
 * The identity every data element carries, from [MS-FSSHTTPB] 2.2.1.12.2.
 *
 * A data element package is a flat list; what a given element *is* — a storage
 * index, a revision manifest, an object group — is declared in the element's
 * own data, before its children. Reading just that header is enough to sort the
 * package into its parts, and it is a precise check on the primitives: the
 * three fields must consume the element's declared length exactly, with no
 * slack to absorb a mistake.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { Cursor, ExtendedGuid, NIL_GUID } from './binary';
import { WalkNode } from './walk';

/** [MS-FSSHTTPB] 2.2.1.12.2 — the kinds of data element. */
export enum DataElementType {
	StorageIndex = 1,
	StorageManifest = 2,
	CellManifest = 3,
	RevisionManifest = 4,
	ObjectGroup = 5,
	DataElementFragment = 6,
	/**
	 * 0x0A, not 7 — the types are not contiguous. Guessing the next number
	 * looked right for as long as no fixture embedded a file, because a section
	 * with no attachments never emits one of these.
	 */
	ObjectDataBlob = 0x0a,
}

/** [MS-FSSHTTPB] 2.2.1.9 — a serial number: a GUID and a 64-bit ordinal, or null. */
export interface SerialNumber {
	identifier: string;
	value: number;
}

export interface DataElementHeader {
	id: ExtendedGuid;
	serial: SerialNumber;
	type: DataElementType;
	/** How many bytes of the element's data the header used. */
	length: number;
}

export const NULL_SERIAL: SerialNumber = { identifier: NIL_GUID, value: 0 };

/** The stream object type that frames a data element. */
export const DATA_ELEMENT_TYPE = 0x01;

/** The stream object type that frames the data element package. */
export const DATA_ELEMENT_PACKAGE_TYPE = 0x15;

function readSerialNumber(cursor: Cursor): SerialNumber {
	const marker = cursor.readUInt8();
	if (marker === 0) return { ...NULL_SERIAL };

	if (marker !== 0x80) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_SERIAL_NUMBER',
			`Byte 0x${marker.toString(16)} does not begin a serial number.`, cursor.position - 1);
	}

	const identifier = cursor.readGuid();
	const low = cursor.readUInt32();
	const high = cursor.readUInt32();
	const value = high * 0x1_0000_0000 + low;

	if (!Number.isSafeInteger(value)) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_HUGE_INTEGER',
			'A serial number exceeds the range this reader supports.', cursor.position - 8);
	}

	return { identifier, value };
}

/**
 * Read one data element's identity out of a walked node.
 *
 * The node must be a data element; its own data holds the three fields and
 * nothing else, which this checks rather than assumes.
 */
export function readDataElementHeader(data: Uint8Array, node: WalkNode): DataElementHeader {
	if (node.type !== DATA_ELEMENT_TYPE) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_NOT_DATA_ELEMENT',
			`Stream object type 0x${node.type.toString(16)} is not a data element.`, node.offset);
	}

	const cursor = new Cursor(data, node.dataOffset, node.dataOffset + node.dataLength);
	const id = cursor.readExtendedGuid();
	const serial = readSerialNumber(cursor);
	const type = cursor.readCompactUint();
	const length = cursor.position - node.dataOffset;

	if (!cursor.atEnd) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_DATA_ELEMENT_LENGTH',
			`A data element declares ${node.dataLength} bytes but its header uses ${length}.`, node.dataOffset);
	}
	if (!(type in DataElementType)) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_DATA_ELEMENT_TYPE',
			`Data element type ${type} is not one this reader knows.`, node.dataOffset);
	}

	return { id, serial, type, length };
}
