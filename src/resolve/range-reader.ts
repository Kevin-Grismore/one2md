/**
 * Reading a named span without becoming its size.
 *
 * `SectionIndex.read` exists for a range whose size is known to be small — a
 * four-byte type code, a scalar, a GUID. Everything else the index names is as
 * large as the file allows: a note's text, an ink path, a fifty-megabyte
 * attachment. Calling `read` on one of those hands back the whole thing, which
 * is precisely the allocation the index was built to avoid.
 *
 * This is what the conversion uses instead. Fixed-width fields are peeked
 * through the window; anything variable is walked in chunks; and text is
 * decoded across those chunks rather than per chunk, since a chunk boundary
 * lands wherever it lands and a character may straddle it.
 *
 * The two text encodings a OneNote property uses are both here, and both answer
 * a length in the units their callers count in. A text run's boundaries are
 * indices into the decoded string, so a run has to be addressable without
 * decoding what comes before it — which for UTF-16 means arithmetic on the
 * offset, and for the single-byte form means the same.
 */
import { ByteRange } from '../storage/byte-source';
import { ByteWindow } from '../storage/byte-window';

/** How much of a range is looked at per step while walking it. */
export const DEFAULT_STEP_BYTES = 8192;

export function subRange(range: ByteRange, offset: number, length: number): ByteRange {
	return { offset: range.offset + offset, length };
}

/** Fixed-width reads inside a range, and a chunked walk over the rest. */
export class RangeReader {
	readonly window: ByteWindow;
	readonly range: ByteRange;

	constructor(window: ByteWindow, range: ByteRange) {
		this.window = window;
		this.range = range;
	}

	get length(): number {
		return this.range.length;
	}

	u8(offset: number): number {
		return this.window.peek(this.range.offset + offset, 1)[0];
	}

	u16(offset: number): number {
		const bytes = this.window.peek(this.range.offset + offset, 2);
		return bytes[0] | (bytes[1] << 8);
	}

	u32(offset: number): number {
		const bytes = this.window.peek(this.range.offset + offset, 4);
		return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
	}

	/** An owned copy. Only for a span the caller has already bounded. */
	slice(offset: number, length: number): Uint8Array {
		return this.window.read(this.range.offset + offset, length);
	}

	/**
	 * A view into the window, valid only until the next window operation.
	 *
	 * For a caller that copies straight into a buffer of its own. Anything
	 * that wants to hold the bytes wants `slice`.
	 */
	peek(offset: number, length: number): Uint8Array {
		return this.window.peek(this.range.offset + offset, length);
	}

	/**
	 * The range in pieces, each valid only until the next step.
	 *
	 * A consumer must finish with a chunk before asking for the next one: they
	 * are views into the one window buffer, not copies.
	 */
	*steps(offset = 0, length = this.range.length - offset, step = DEFAULT_STEP_BYTES): IterableIterator<Uint8Array> {
		const limit = Math.min(step, this.window.capacity);
		let position = 0;

		while (position < length) {
			const take = Math.min(limit, length - position);
			yield this.window.peek(this.range.offset + offset + position, take);
			position += take;
		}
	}
}

/**
 * The length of a UTF-16LE property value, in the units its readers index by.
 *
 * `readString` decodes the value and then drops trailing NULs, so every
 * boundary a text run declares is an index into the already-trimmed string.
 * Finding that length means looking at the tail, not decoding the whole value:
 * two bytes make one unit, so the count is arithmetic once the NULs are found.
 */
export function utf16Length(window: ByteWindow, range: ByteRange): number {
	const units = range.length >>> 1;
	let end = units;

	while (end > 0) {
		// A backward walk, a window at a time, so a value that is entirely NUL
		// costs reads rather than an allocation of its own size.
		const from = Math.max(0, end - (window.capacity >>> 1));
		const chunk = window.peek(range.offset + from * 2, (end - from) * 2);

		let index = end - from;
		while (index > 0 && chunk[(index - 1) * 2] === 0 && chunk[(index - 1) * 2 + 1] === 0) index--;

		end = from + index;
		if (index > 0 || from === 0) break;
	}

	return end;
}

/**
 * A slice of a UTF-16LE value, decoded in pieces.
 *
 * The decoder is kept across chunks deliberately: a surrogate pair is four
 * bytes and a chunk can end between its halves, so decoding each chunk alone
 * would replace the character with U+FFFD. Chunks are cut on unit boundaries
 * for the same reason.
 */
export function* utf16Text(
	window: ByteWindow,
	range: ByteRange,
	startUnit: number,
	endUnit: number,
	step = DEFAULT_STEP_BYTES,
): IterableIterator<string> {
	if (endUnit <= startUnit) return;

	const decoder = new TextDecoder('utf-16le');
	const limit = Math.max(2, (Math.min(step, window.capacity) >>> 1) * 2);
	let unit = startUnit;

	while (unit < endUnit) {
		const take = Math.min(limit >>> 1, endUnit - unit);
		const piece = decoder.decode(window.peek(range.offset + unit * 2, take * 2), { stream: true });
		if (piece !== '') yield piece;
		unit += take;
	}

	const tail = decoder.decode();
	if (tail !== '') yield tail;
}

/**
 * The length of a single-byte value, after trailing NULs.
 *
 * `readSingleByteString` widens each byte to a character, so a byte is a unit
 * and the arithmetic is the same as above without the halving.
 */
export function asciiLength(window: ByteWindow, range: ByteRange): number {
	let end = range.length;

	while (end > 0) {
		const from = Math.max(0, end - window.capacity);
		const chunk = window.peek(range.offset + from, end - from);

		let index = end - from;
		while (index > 0 && chunk[index - 1] === 0) index--;

		end = from + index;
		if (index > 0 || from === 0) break;
	}

	return end;
}

/** A slice of a single-byte value, one character per byte as its reader does. */
export function* asciiText(
	window: ByteWindow,
	range: ByteRange,
	start: number,
	end: number,
	step = DEFAULT_STEP_BYTES,
): IterableIterator<string> {
	if (end <= start) return;

	const limit = Math.min(step, window.capacity);
	let position = start;

	while (position < end) {
		const take = Math.min(limit, end - position);
		const chunk = window.peek(range.offset + position, take);

		let piece = '';
		for (let index = 0; index < take; index++) piece += String.fromCharCode(chunk[index]);
		yield piece;

		position += take;
	}
}
