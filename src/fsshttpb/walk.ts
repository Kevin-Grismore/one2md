/**
 * A structural walk over the stream objects in an MS-FSSHTTPB package.
 *
 * This does not interpret any structure — it only follows the framing, which is
 * exactly what makes it useful as a check on the primitives. The framing is
 * dense and self-delimiting, so if the compact-integer or Extended GUID widths
 * were wrong the walk would desynchronise: a start header would land mid-field,
 * its type would be nonsense, and the nesting would fail to close. A walk that
 * closes every compound object and finishes precisely at the end of the file is
 * strong evidence the encodings are right.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { Cursor, StreamObjectHeader } from './binary';

export interface WalkNode {
	type: number;
	compound: boolean;
	/** Offset of the object's header in the file. */
	offset: number;
	/** Offset of the object's own data, just past its header. */
	dataOffset: number;
	/** The length of that data, excluding any children. */
	dataLength: number;
	children: WalkNode[];
}

export interface WalkResult {
	roots: WalkNode[];
	/** Where the payload started, just past the packaging prefix. */
	start: number;
	/** Where the packaging object closed. */
	end: number;
	/** Bytes after the packaging object. OneNote pads the file with zeros. */
	trailing: number;
	/** Every distinct stream object type seen, with how often. */
	histogram: Map<number, number>;
	maxDepth: number;
}

const MAX_DEPTH = 64;

/**
 * Where the packaging stream object begins in a packaged `.one` file.
 *
 * The envelope is a fixed 68-byte prefix and then a compound stream object of
 * type 0x7a whose own data is the storage index Extended GUID and the cell
 * schema GUID — both already validated by `readFileHeader` — and whose children
 * are the entire data element package. The walk starts at that header rather
 * than after it, so the package is framed by the object that actually contains
 * it and its closing end header has something to close.
 */
export const PACKAGING_START = 68;
export const PACKAGING_OBJECT_TYPE = 0x7a;

export function walk(data: Uint8Array, from = PACKAGING_START): WalkResult {
	const cursor = new Cursor(data, from);
	const histogram = new Map<number, number>();
	const roots: WalkNode[] = [];
	let maxDepth = 0;

	const count = (type: number) => histogram.set(type, (histogram.get(type) ?? 0) + 1);

	/** Read exactly one stream object, and its children when it is compound. */
	const readOne = (into: WalkNode[], depth: number): void => {
		const mark = cursor.position;
		const header = cursor.readStreamObjectHeader();

		if (header.kind !== 'start') {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_UNBALANCED',
				'The packaging structure does not begin with a start header.', mark);
		}

		count(header.type);
		const node: WalkNode = {
			type: header.type,
			compound: header.compound,
			offset: mark,
			dataOffset: mark + header.headerLength,
			dataLength: header.length,
			children: [],
		};
		into.push(node);

		cursor.skip(header.length);
		if (header.compound) readChildren(node.children, depth + 1, header.type);
	};

	const readChildren = (into: WalkNode[], depth: number, closing: number): void => {
		if (depth > MAX_DEPTH) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_DEPTH',
				'Stream objects nest deeper than this reader will follow.', cursor.position);
		}
		maxDepth = Math.max(maxDepth, depth);

		while (!cursor.atEnd) {
			const mark = cursor.position;
			const header: StreamObjectHeader = cursor.readStreamObjectHeader();

			if (header.kind === 'end') {
				if (header.type !== closing) {
					throw new OneNoteFormatError('ONENOTE_FSSHTTPB_UNBALANCED',
						`Object type 0x${closing.toString(16)} is closed by an end header for `
						+ `0x${header.type.toString(16)}.`, mark);
				}
				return;
			}

			count(header.type);
			const node: WalkNode = {
				type: header.type,
				compound: header.compound,
				offset: mark,
				dataOffset: mark + header.headerLength,
				dataLength: header.length,
				children: [],
			};
			into.push(node);

			cursor.skip(header.length);
			if (header.compound) readChildren(node.children, depth + 1, header.type);
		}

		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_UNBALANCED',
			`Object type 0x${closing.toString(16)} is never closed.`, cursor.position);
	};

	// Only the packaging object is read. What follows it is padding, and letting
	// the walk continue would happily consume a run of zero bytes as an
	// unbounded series of empty 16-bit start headers.
	readOne(roots, 0);
	const end = cursor.position;

	for (let index = end; index < data.length; index++) {
		if (data[index] !== 0) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_TRAILING',
				'The bytes after the packaging object are not padding.', index);
		}
	}

	return { roots, start: from, end, trailing: data.length - end, histogram, maxDepth };
}
