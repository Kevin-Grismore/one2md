/**
 * The MS-FSSHTTPB primitives, read from a window instead of a whole file.
 *
 * `Cursor` needs the bytes it decodes to be in one array, which for a packaged
 * `.one` file means the whole file. Every encoding it reads is small, though —
 * the widest is a 21-byte Extended GUID — so a bounded reader can borrow just
 * enough bytes for one field at a time and hand them to the same decoder.
 *
 * That is what this does: each read frames a few bytes of the sliding window
 * and runs `Cursor` over them, with `base` set so an error names the offset in
 * the file rather than in the scratch buffer. Reusing the decoders matters more
 * than the indirection costs — a second, subtly different implementation of the
 * compact integer or the Extended GUID widths is exactly the bug that would be
 * hardest to notice, because a misread width desynchronises the stream rather
 * than returning an obviously wrong number.
 *
 * The one thing it adds is skipping. An object's reference arrays and its
 * property-set bytes are named by range and read later, so the walk must step
 * over them knowing only their encoded widths.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { ByteRange } from '../storage/byte-source';
import { ByteWindow } from '../storage/byte-window';
import { CellId, Cursor, ExtendedGuid, StreamObjectHeader } from './binary';

/** Widest encoding of each primitive, so one peek always covers a field. */
const WIDTH = {
	compactUint: 9,
	extendedGuid: 21,
	cellId: 42,
	guid: 16,
	serial: 25,
	streamObjectHeader: 13,
	fixed: 4,
} as const;

/** A counted array, named rather than decoded. */
export interface CountedRange {
	count: number;
	range: ByteRange;
}

export class SourceCursor {
	position: number;

	readonly #window: ByteWindow;
	readonly #limit: number;

	constructor(window: ByteWindow, start = 0, limit = window.size) {
		if (limit > window.size) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_RANGE',
				'A structure claims to extend past the end of the file.', start);
		}
		this.#window = window;
		this.#limit = limit;
		this.position = start;
	}

	get limit(): number {
		return this.#limit;
	}

	get remaining(): number {
		return this.#limit - this.position;
	}

	get atEnd(): boolean {
		return this.position >= this.#limit;
	}

	/** A cursor confined to `length` bytes starting here. */
	sub(length: number): SourceCursor {
		this.#ensure(length);
		return new SourceCursor(this.#window, this.position, this.position + length);
	}

	skip(length: number): void {
		this.#ensure(length);
		this.position += length;
	}

	readUInt8(): number {
		return this.#run(WIDTH.fixed, cursor => cursor.readUInt8());
	}

	readUInt16(): number {
		return this.#run(WIDTH.fixed, cursor => cursor.readUInt16());
	}

	readUInt32(): number {
		return this.#run(WIDTH.fixed, cursor => cursor.readUInt32());
	}

	readGuid(): string {
		return this.#run(WIDTH.guid, cursor => cursor.readGuid());
	}

	readCompactUint(): number {
		return this.#run(WIDTH.compactUint, cursor => cursor.readCompactUint());
	}

	readExtendedGuid(): ExtendedGuid {
		return this.#run(WIDTH.extendedGuid, cursor => cursor.readExtendedGuid());
	}

	readCellId(): CellId {
		return this.#run(WIDTH.cellId, cursor => cursor.readCellId());
	}

	/** The header's `offset` is already absolute, since the frame starts here. */
	readStreamObjectHeader(): StreamObjectHeader {
		return this.#run(WIDTH.streamObjectHeader, cursor => cursor.readStreamObjectHeader());
	}

	/** [MS-FSSHTTPB] 2.2.1.9 — a serial number: a GUID and a 64-bit ordinal. */
	readSerialNumber(): { identifier: string, value: number } {
		return this.#run(WIDTH.serial, cursor => {
			const marker = cursor.readUInt8();
			if (marker === 0) return { identifier: '00000000-0000-0000-0000-000000000000', value: 0 };

			if (marker !== 0x80) {
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_SERIAL_NUMBER',
					`Byte 0x${marker.toString(16)} does not begin a serial number.`, cursor.base + cursor.position - 1);
			}

			const identifier = cursor.readGuid();
			const low = cursor.readUInt32();
			const high = cursor.readUInt32();
			const value = high * 0x1_0000_0000 + low;

			if (!Number.isSafeInteger(value)) {
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_HUGE_INTEGER',
					'A serial number exceeds the range this reader supports.', cursor.base + cursor.position - 8);
			}

			return { identifier, value };
		});
	}

	/** [MS-FSSHTTPB] 2.2.1.8 — steps over a counted Extended GUID array. */
	skipExtendedGuidArray(): CountedRange {
		const offset = this.position;
		const count = this.readCompactUint();
		for (let index = 0; index < count; index++) this.readExtendedGuid();
		return { count, range: { offset, length: this.position - offset } };
	}

	/** [MS-FSSHTTPB] 2.2.1.11 — steps over a counted cell-identifier array. */
	skipCellIdArray(): CountedRange {
		const offset = this.position;
		const count = this.readCompactUint();
		for (let index = 0; index < count; index++) this.readCellId();
		return { count, range: { offset, length: this.position - offset } };
	}

	/**
	 * [MS-FSSHTTPB] 2.2.1.3 — a binary item, named rather than read.
	 *
	 * The range covers the payload only, not the compact length in front of it,
	 * so it is what `readBinaryItem` would have returned.
	 */
	readBinaryItemRange(): ByteRange {
		const length = this.readCompactUint();
		const offset = this.position;
		this.skip(length);
		return { offset, length };
	}

	#ensure(length: number): void {
		if (length < 0 || this.position + length > this.#limit) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_RANGE',
				`Reading ${length} bytes would pass the end of the structure.`, this.position);
		}
	}

	#run<T>(maxBytes: number, decode: (cursor: Cursor) => T): T {
		const start = this.position;
		const span = Math.max(Math.min(maxBytes, this.#limit - start), 0);
		// A short span is not an error here: it is what a field running past the
		// end of its structure looks like, and the decoder raises it as one.
		const cursor = new Cursor(this.#window.peek(start, span), 0, span, start);
		const value = decode(cursor);

		this.position = start + cursor.position;
		return value;
	}
}
