/**
 * The data element package: [MS-FSSHTTPB] 2.2.1.12.
 *
 * A packaged `.one` file holds one flat list of data elements. Five kinds
 * matter here, and together they describe a chain: the storage index says where
 * each manifest and revision lives, the storage manifest names the root cells,
 * a cell manifest names its current revision, a revision manifest names its
 * root objects and the object groups holding them, and an object group holds
 * the object bytes themselves.
 *
 * Every structure here is read with `readExact`, which fails unless the fields
 * consume the stream object's declared length precisely. The format gives no
 * padding to hide a mistake in, so that check is what turns "it parsed" into
 * evidence that it parsed correctly.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { CellId, Cursor, ExtendedGuid, extendedGuidKey } from './binary';
import { DataElementType, readDataElementHeader, SerialNumber } from './data-element';
import { StreamObject } from './types';
import { walk, WalkNode } from './walk';

export interface StorageIndexManifestMapping {
	id: ExtendedGuid;
	serial: SerialNumber;
}

export interface StorageIndexCellMapping {
	cell: CellId;
	id: ExtendedGuid;
	serial: SerialNumber;
}

export interface StorageIndexRevisionMapping {
	revision: ExtendedGuid;
	id: ExtendedGuid;
	serial: SerialNumber;
}

export interface StorageIndex {
	manifestMappings: StorageIndexManifestMapping[];
	cellMappings: StorageIndexCellMapping[];
	revisionMappings: StorageIndexRevisionMapping[];
}

export interface StorageManifestRoot {
	root: ExtendedGuid;
	cell: CellId;
}

export interface StorageManifest {
	schema: string;
	roots: StorageManifestRoot[];
}

export interface CellManifest {
	currentRevision: ExtendedGuid;
}

export interface RevisionManifestRoot {
	root: ExtendedGuid;
	object: ExtendedGuid;
}

export interface RevisionManifest {
	revision: ExtendedGuid;
	baseRevision: ExtendedGuid;
	roots: RevisionManifestRoot[];
	objectGroups: ExtendedGuid[];
}

export interface ObjectDeclaration {
	object: ExtendedGuid;
	/** Set only for a blob-reference declaration, which names its payload element. */
	blob?: ExtendedGuid;
	partition: number;
	/** Absent on a blob reference, which carries no inline data. */
	dataSize?: number;
	objectReferenceCount: number;
	cellReferenceCount: number;
}

export interface ObjectData {
	objectReferences: ExtendedGuid[];
	cellReferences: CellId[];
	/** The object's own bytes, or undefined when it is a blob reference. */
	data?: Uint8Array;
	/** The data element holding the payload, for a blob reference. */
	blob?: ExtendedGuid;
}

export interface ObjectGroup {
	declarations: ObjectDeclaration[];
	data: ObjectData[];
}

export interface DataElementPackage {
	storageIndex: StorageIndex;
	storageManifest: StorageManifest;
	/** Keyed by the data element's Extended GUID. */
	cellManifests: Map<string, CellManifest>;
	revisionManifests: Map<string, RevisionManifest>;
	objectGroups: Map<string, ObjectGroup>;
}

/**
 * Read one stream object's data, insisting the reader consumes all of it.
 *
 * A structure that stops short means a field was read too narrow; one that runs
 * over means too wide. Either way the answer downstream would be wrong, so
 * neither is allowed to pass.
 */
function readExact<T>(data: Uint8Array, node: WalkNode, read: (cursor: Cursor) => T): T {
	const cursor = new Cursor(data, node.dataOffset, node.dataOffset + node.dataLength);
	const value = read(cursor);

	if (!cursor.atEnd) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_STRUCTURE_LENGTH',
			`Stream object 0x${node.type.toString(16)} declares ${node.dataLength} bytes `
			+ `but its fields used ${cursor.position - node.dataOffset}.`, node.dataOffset);
	}

	return value;
}

function expect(node: WalkNode | undefined, type: StreamObject, what: string): WalkNode {
	if (!node || node.type !== type) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MISSING_STRUCTURE',
			`Expected ${what} (0x${type.toString(16)}) but found `
			+ (node ? `0x${node.type.toString(16)}` : 'nothing') + '.', node?.offset);
	}
	return node;
}

function readSerial(cursor: Cursor): SerialNumber {
	const marker = cursor.readUInt8();
	if (marker === 0) return { identifier: '00000000-0000-0000-0000-000000000000', value: 0 };

	if (marker !== 0x80) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_SERIAL_NUMBER',
			`Byte 0x${marker.toString(16)} does not begin a serial number.`, cursor.position - 1);
	}

	const identifier = cursor.readGuid();
	const low = cursor.readUInt32();
	const high = cursor.readUInt32();
	return { identifier, value: high * 0x1_0000_0000 + low };
}

function readStorageIndex(data: Uint8Array, element: WalkNode): StorageIndex {
	const index: StorageIndex = { manifestMappings: [], cellMappings: [], revisionMappings: [] };

	for (const child of element.children) {
		switch (child.type) {
			case StreamObject.StorageIndexManifestMapping:
				index.manifestMappings.push(readExact(data, child, cursor => ({
					id: cursor.readExtendedGuid(),
					serial: readSerial(cursor),
				})));
				break;
			case StreamObject.StorageIndexCellMapping:
				index.cellMappings.push(readExact(data, child, cursor => ({
					cell: cursor.readCellId(),
					id: cursor.readExtendedGuid(),
					serial: readSerial(cursor),
				})));
				break;
			case StreamObject.StorageIndexRevisionMapping:
				index.revisionMappings.push(readExact(data, child, cursor => ({
					revision: cursor.readExtendedGuid(),
					id: cursor.readExtendedGuid(),
					serial: readSerial(cursor),
				})));
				break;
			default:
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MISSING_STRUCTURE',
					`A storage index cannot hold a 0x${child.type.toString(16)}.`, child.offset);
		}
	}

	return index;
}

function readStorageManifest(data: Uint8Array, element: WalkNode): StorageManifest {
	const schemaNode = expect(element.children.at(0), StreamObject.StorageManifestSchemaGuid, 'a schema GUID');
	const schema = readExact(data, schemaNode, cursor => cursor.readGuid());

	const roots = element.children.slice(1).map(child => readExact(
		data,
		expect(child, StreamObject.StorageManifestRootDeclare, 'a root declaration'),
		cursor => ({ root: cursor.readExtendedGuid(), cell: cursor.readCellId() })));

	return { schema, roots };
}

function readCellManifest(data: Uint8Array, element: WalkNode): CellManifest {
	const node = expect(element.children.at(0), StreamObject.CellManifestCurrentRevision, 'a current revision');
	return { currentRevision: readExact(data, node, cursor => cursor.readExtendedGuid()) };
}

function readRevisionManifest(data: Uint8Array, element: WalkNode): RevisionManifest {
	const head = expect(element.children.at(0), StreamObject.RevisionManifest, 'a revision manifest');
	const { revision, baseRevision } = readExact(data, head, cursor => ({
		revision: cursor.readExtendedGuid(),
		baseRevision: cursor.readExtendedGuid(),
	}));

	const manifest: RevisionManifest = { revision, baseRevision, roots: [], objectGroups: [] };

	for (const child of element.children.slice(1)) {
		switch (child.type) {
			case StreamObject.RevisionManifestRootDeclare:
				manifest.roots.push(readExact(data, child, cursor => ({
					root: cursor.readExtendedGuid(),
					object: cursor.readExtendedGuid(),
				})));
				break;
			case StreamObject.RevisionManifestObjectGroupReference:
				manifest.objectGroups.push(readExact(data, child, cursor => cursor.readExtendedGuid()));
				break;
			default:
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MISSING_STRUCTURE',
					`A revision manifest cannot hold a 0x${child.type.toString(16)}.`, child.offset);
		}
	}

	return manifest;
}

function readObjectGroup(data: Uint8Array, element: WalkNode): ObjectGroup {
	const group: ObjectGroup = { declarations: [], data: [] };

	for (const section of element.children) {
		if (section.type === StreamObject.ObjectGroupDeclarations) {
			for (const child of section.children) {
				const isBlobReference = child.type === StreamObject.ObjectGroupObjectDeclareBlobReference;
				if (!isBlobReference) expect(child, StreamObject.ObjectGroupObjectDeclare, 'an object declaration');

				group.declarations.push(readExact(data, child, cursor => ({
					object: cursor.readExtendedGuid(),
					// A blob reference names its payload element instead of
					// carrying a size, so the two forms differ by one field each.
					blob: isBlobReference ? cursor.readExtendedGuid() : undefined,
					partition: cursor.readCompactUint(),
					dataSize: isBlobReference ? undefined : cursor.readCompactUint(),
					objectReferenceCount: cursor.readCompactUint(),
					cellReferenceCount: cursor.readCompactUint(),
				})));
			}
			continue;
		}

		if (section.type === StreamObject.ObjectGroupData) {
			for (const child of section.children) {
				const isBlobReference = child.type === StreamObject.ObjectGroupObjectDataBlobReference;
				if (!isBlobReference) expect(child, StreamObject.ObjectGroupObjectData, 'object data');

				group.data.push(readExact(data, child, cursor => ({
					// The object's identity is not repeated here; it comes from
					// the declaration at the same position.
					objectReferences: cursor.readExtendedGuidArray(),
					cellReferences: cursor.readCellIdArray(),
					data: isBlobReference ? undefined : cursor.readBinaryItem(),
					blob: isBlobReference ? cursor.readExtendedGuid() : undefined,
				})));
			}
			continue;
		}

		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MISSING_STRUCTURE',
			`An object group cannot hold a 0x${section.type.toString(16)}.`, section.offset);
	}

	return group;
}

/** Read the whole data element package out of a packaged `.one` file. */
export function readDataElementPackage(data: Uint8Array): DataElementPackage {
	const root = walk(data).roots[0];
	const packageNode = expect(root.children.at(0), StreamObject.DataElementPackage, 'a data element package');

	let storageIndex: StorageIndex | undefined;
	let storageManifest: StorageManifest | undefined;
	const cellManifests = new Map<string, CellManifest>();
	const revisionManifests = new Map<string, RevisionManifest>();
	const objectGroups = new Map<string, ObjectGroup>();

	for (const element of packageNode.children) {
		const header = readDataElementHeader(data, element);
		const key = extendedGuidKey(header.id);

		switch (header.type) {
			case DataElementType.StorageIndex:
				storageIndex = readStorageIndex(data, element);
				break;
			case DataElementType.StorageManifest:
				storageManifest = readStorageManifest(data, element);
				break;
			case DataElementType.CellManifest:
				cellManifests.set(key, readCellManifest(data, element));
				break;
			case DataElementType.RevisionManifest:
				revisionManifests.set(key, readRevisionManifest(data, element));
				break;
			case DataElementType.ObjectGroup:
				objectGroups.set(key, readObjectGroup(data, element));
				break;
			default:
				// Fragments and standalone blobs do not appear in a packaged
				// section; ignoring one is safer than guessing at its meaning.
				break;
		}
	}

	if (!storageIndex) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_NO_STORAGE_INDEX',
			'The data element package has no storage index.');
	}
	if (!storageManifest) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_NO_STORAGE_MANIFEST',
			'The data element package has no storage manifest.');
	}

	return { storageIndex, storageManifest, cellManifests, revisionManifests, objectGroups };
}
