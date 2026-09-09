/**
 * The same structural walk as `walk`, emitted rather than assembled.
 *
 * `walk` returns a `WalkNode` tree: one object per stream object, each holding
 * an array of its children, all of it alive until the package has been read.
 * A packaged section is nothing but stream objects — every object declaration,
 * every object's data, every blob is one — so that tree is proportional to the
 * section and is the packaged encoding's equivalent of a whole parse.
 *
 * The framing itself does not need a tree. It is dense, self-delimiting and
 * strictly nested, so a walker only has to remember which types are currently
 * open. This yields a start and an end event for each object and keeps a stack
 * of open types bounded by the depth limit — sixty-four entries, whatever the
 * file contains. A consumer that cares about one structure reads it from the
 * event's range and lets the rest go by.
 *
 * The checks are the ones `walk` makes: a start header first, every compound
 * object closed by an end header for its own type, nothing nested past the
 * depth limit, and only zero padding after the packaging object.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { ByteWindow } from '../storage/byte-window';
import { SourceCursor } from './source-cursor';
import { PACKAGING_START } from './walk';

export const MAX_DEPTH = 64;

export interface StreamObjectEvent {
	kind: 'start' | 'end';
	type: number;
	/** Start events only: whether children follow before the matching end. */
	compound: boolean;
	/** How many objects enclose this one. The packaging object is at zero. */
	depth: number;
	/** Where the object's header begins in the file. */
	offset: number;
	/** Where its own data begins, just past that header. */
	dataOffset: number;
	/** The length of that data, excluding any children. */
	dataLength: number;
}

/**
 * Every stream object in the packaging object, in file order.
 *
 * Only the packaging object is walked, for the reason `walk` gives: what
 * follows it is zero padding, and reading on would take a run of zeros as an
 * unbounded series of empty 16-bit start headers.
 */
export function* walkStreamObjects(window: ByteWindow, from = PACKAGING_START): Generator<StreamObjectEvent> {
	const cursor = new SourceCursor(window, from);
	const open: number[] = [];

	const first = cursor.readStreamObjectHeader();
	if (first.kind !== 'start') {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_UNBALANCED',
			'The packaging structure does not begin with a start header.', from);
	}

	yield {
		kind: 'start',
		type: first.type,
		compound: first.compound,
		depth: 0,
		offset: first.offset,
		dataOffset: first.offset + first.headerLength,
		dataLength: first.length,
	};
	cursor.skip(first.length);
	if (first.compound) open.push(first.type);

	while (open.length > 0) {
		if (cursor.atEnd) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_UNBALANCED',
				`Object type 0x${open[open.length - 1].toString(16)} is never closed.`, cursor.position);
		}
		if (open.length > MAX_DEPTH) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_DEPTH',
				'Stream objects nest deeper than this reader will follow.', cursor.position);
		}

		const mark = cursor.position;
		const header = cursor.readStreamObjectHeader();

		if (header.kind === 'end') {
			const closing = open[open.length - 1];
			if (header.type !== closing) {
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_UNBALANCED',
					`Object type 0x${closing.toString(16)} is closed by an end header for `
					+ `0x${header.type.toString(16)}.`, mark);
			}

			open.pop();
			yield {
				kind: 'end',
				type: header.type,
				compound: false,
				depth: open.length,
				offset: mark,
				dataOffset: cursor.position,
				dataLength: 0,
			};
			continue;
		}

		yield {
			kind: 'start',
			type: header.type,
			compound: header.compound,
			depth: open.length,
			offset: mark,
			dataOffset: mark + header.headerLength,
			dataLength: header.length,
		};

		cursor.skip(header.length);
		if (header.compound) open.push(header.type);
	}

	checkPadding(window, cursor.position);
}

/** OneNote pads the file after the packaging object; anything else is a fault. */
function checkPadding(window: ByteWindow, from: number): void {
	for (let offset = from; offset < window.size;) {
		const span = Math.min(window.capacity, window.size - offset);
		const chunk = window.peek(offset, span);

		for (let index = 0; index < span; index++) {
			if (chunk[index] !== 0) {
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_TRAILING',
					'The bytes after the packaging object are not padding.', offset + index);
			}
		}

		offset += span;
	}
}
