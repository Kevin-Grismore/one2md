/**
 * MS-FSSHTTPB primitive encodings.
 *
 * A `.one` file written by OneNote's sync path is not a desktop revision store.
 * It is an MS-ONESTORE packaging envelope wrapping an MS-FSSHTTPB data element
 * package, and everything in that package is built from the four encodings
 * here: a variable-width integer, a variable-width GUID-plus-ordinal, a cell
 * identifier, and the stream object headers that frame every structure.
 *
 * Written against [MS-FSSHTTPB] 2.2.1, published by Microsoft under the Open
 * Specification Promise. No code is taken from any other implementation.
 *
 * These encodings are self-checking in practice: they are dense and
 * self-delimiting, so a misread width desynchronises the whole stream within a
 * few bytes rather than quietly returning a wrong number. That is what makes a
 * walk over a real file a meaningful test of them.
 */
import { OneNoteFormatError } from '../onenote-file/errors';

export interface ExtendedGuid {
	/** Lowercase, hyphenated. The nil GUID for a null Extended GUID. */
	identifier: string;
	value: number;
}

export interface CellId {
	first: ExtendedGuid;
	second: ExtendedGuid;
}

export const NIL_GUID = '00000000-0000-0000-0000-000000000000';
export const NULL_EXTENDED_GUID: ExtendedGuid = { identifier: NIL_GUID, value: 0 };

export function isNullExtendedGuid(id: ExtendedGuid): boolean {
	return id.identifier === NIL_GUID && id.value === 0;
}

export function extendedGuidKey(id: ExtendedGuid): string {
	return `${id.identifier}:${id.value}`;
}

/** Stream object header kinds, from the low two bits of the first byte. */
export type StreamObjectKind = 'start' | 'end';

export interface StreamObjectHeader {
	kind: StreamObjectKind;
	/** The stream object type. Widths differ per header form; the value does not. */
	type: number;
	/** Start headers only: whether the object has children and a matching end header. */
	compound: boolean;
	/** Start headers only: the length of the object's own data, excluding children. */
	length: number;
	/** Where the header began, for diagnostics. */
	offset: number;
	/** How many bytes the header itself occupied. */
	headerLength: number;
}

/**
 * A forward-only reader over one buffer.
 *
 * Every read is bounds-checked against the buffer and against an optional
 * `limit`, so a structure that claims to be longer than its parent cannot walk
 * off into the next one.
 */
export class Cursor {
	position: number;

	constructor(readonly data: Uint8Array, start = 0, private limit = data.length) {
		this.position = start;
		if (limit > data.length) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_RANGE',
				'A structure claims to extend past the end of the file.', start);
		}
	}

	get remaining(): number {
		return this.limit - this.position;
	}

	get atEnd(): boolean {
		return this.position >= this.limit;
	}

	/** A cursor over `length` bytes starting here, without copying. */
	sub(length: number): Cursor {
		this.ensure(length);
		return new Cursor(this.data, this.position, this.position + length);
	}

	private ensure(length: number): void {
		if (length < 0 || this.position + length > this.limit) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_RANGE',
				`Reading ${length} bytes would pass the end of the structure.`, this.position);
		}
	}

	skip(length: number): void {
		this.ensure(length);
		this.position += length;
	}

	readUInt8(): number {
		this.ensure(1);
		return this.data[this.position++];
	}

	readUInt16(): number {
		this.ensure(2);
		const value = this.data[this.position] | (this.data[this.position + 1] << 8);
		this.position += 2;
		return value;
	}

	readUInt32(): number {
		this.ensure(4);
		const { data, position } = this;
		const value = (data[position] | (data[position + 1] << 8)
			| (data[position + 2] << 16) | (data[position + 3] << 24)) >>> 0;
		this.position += 4;
		return value;
	}

	/** A view of the next `length` bytes. Shares memory with the file. */
	readBytes(length: number): Uint8Array {
		this.ensure(length);
		const view = this.data.subarray(this.position, this.position + length);
		this.position += length;
		return view;
	}

	/** A GUID stored in the little-endian mixed-endian layout Windows uses. */
	readGuid(): string {
		this.ensure(16);
		const hex: string[] = [];
		for (let index = 0; index < 16; index++) hex.push(this.data[this.position + index].toString(16).padStart(2, '0'));
		this.position += 16;

		const at = (...order: number[]) => order.map(index => hex[index]).join('');
		return `${at(3, 2, 1, 0)}-${at(5, 4)}-${at(7, 6)}-${at(8, 9)}-${at(10, 11, 12, 13, 14, 15)}`;
	}

	/**
	 * [MS-FSSHTTPB] 2.2.1.1 — a compact unsigned 64-bit integer.
	 *
	 * The low bits of the first byte say how wide the encoding is: the position
	 * of its lowest set bit gives the width, and the value occupies everything
	 * above that marker. A first byte of zero is the value zero, and 0x80
	 * introduces a full 64-bit value in the eight bytes that follow.
	 *
	 * Returned as a JS number. Values above 2^53 cannot occur in a file this
	 * reader will accept — every use is a length, a count or an ordinal bounded
	 * by the file size — and one is rejected rather than silently rounded.
	 */
	readCompactUint(): number {
		const first = this.data[this.position];
		if (this.position >= this.limit) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_RANGE',
				'A compact integer begins past the end of the structure.', this.position);
		}

		if (first === 0) {
			this.position++;
			return 0;
		}

		if (first === 0x80) {
			this.ensure(9);
			this.position++;
			const low = this.readUInt32();
			const high = this.readUInt32();
			const value = high * 0x1_0000_0000 + low;
			if (!Number.isSafeInteger(value)) {
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_HUGE_INTEGER',
					'A compact integer exceeds the range this reader supports.', this.position - 9);
			}
			return value;
		}

		// The lowest set bit marks the width; 1 << width is that marker.
		let width = 0;
		while (width < 7 && (first & (1 << width)) === 0) width++;
		const bytes = width + 1;
		this.ensure(bytes);

		// Read the whole encoding little-endian, then shift the marker away.
		// Done in floating point above 32 bits, which is exact to 2^53.
		let raw = 0;
		for (let index = bytes - 1; index >= 0; index--) raw = raw * 256 + this.data[this.position + index];
		this.position += bytes;

		return Math.floor(raw / Math.pow(2, width + 1));
	}

	/**
	 * [MS-FSSHTTPB] 2.2.1.7 — an Extended GUID: a GUID with an ordinal.
	 *
	 * Four widths carry non-overlapping ordinal ranges, plus a null form. The
	 * type occupies the low bits of the first byte and the ordinal the rest, so
	 * the GUID always follows on a byte boundary.
	 */
	readExtendedGuid(): ExtendedGuid {
		const start = this.position;
		const first = this.readUInt8();

		if (first === 0) return { ...NULL_EXTENDED_GUID };

		// 3-bit type 0b100, 5-bit value.
		if ((first & 0x07) === 0x04) {
			const value = first >>> 3;
			return { identifier: this.readGuid(), value };
		}

		// 6-bit type 0b100000, 10-bit value.
		if ((first & 0x3f) === 0x20) {
			const value = (first >>> 6) | (this.readUInt8() << 2);
			return { identifier: this.readGuid(), value };
		}

		// 7-bit type 0b1000000, 17-bit value.
		if ((first & 0x7f) === 0x40) {
			const value = (first >>> 7) | (this.readUInt16() << 1);
			return { identifier: this.readGuid(), value };
		}

		// 8-bit type 0x80, 32-bit value.
		if (first === 0x80) {
			const value = this.readUInt32();
			return { identifier: this.readGuid(), value };
		}

		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_EXTENDED_GUID',
			`Byte 0x${first.toString(16)} does not begin any Extended GUID encoding.`, start);
	}

	/** [MS-FSSHTTPB] 2.2.1.10 — a cell identifier: a pair of Extended GUIDs. */
	readCellId(): CellId {
		return { first: this.readExtendedGuid(), second: this.readExtendedGuid() };
	}

	/** [MS-FSSHTTPB] 2.2.1.8 — a counted array of Extended GUIDs. */
	readExtendedGuidArray(): ExtendedGuid[] {
		const count = this.readCompactUint();
		const items: ExtendedGuid[] = [];
		for (let index = 0; index < count; index++) items.push(this.readExtendedGuid());
		return items;
	}

	/** [MS-FSSHTTPB] 2.2.1.11 — a counted array of cell identifiers. */
	readCellIdArray(): CellId[] {
		const count = this.readCompactUint();
		const items: CellId[] = [];
		for (let index = 0; index < count; index++) items.push(this.readCellId());
		return items;
	}

	/**
	 * [MS-FSSHTTPB] 2.2.1.3 — a binary item: a compact length, then that many
	 * bytes.
	 *
	 * The length is carried explicitly, so an item is not simply the rest of the
	 * structure it sits in — reading it that way happens to work only when the
	 * item is last, and silently absorbs whatever follows when it is not.
	 */
	readBinaryItem(): Uint8Array {
		return this.readBytes(this.readCompactUint());
	}

	/**
	 * [MS-FSSHTTPB] 2.2.1.5 — a stream object header, in any of its four forms.
	 *
	 * The low two bits pick the form: 0 and 2 begin an object in 16 and 32 bits,
	 * 1 and 3 end one in 8 and 16. A 32-bit start whose length field is all ones
	 * carries its real length in a compact integer that follows.
	 */
	readStreamObjectHeader(): StreamObjectHeader {
		const offset = this.position;
		const first = this.data[this.position];

		if (this.atEnd) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_RANGE',
				'A stream object header begins past the end of the structure.', offset);
		}

		switch (first & 0x03) {
			case 0x00: {
				// 16-bit start: 2 bits form, 1 bit compound, 6 bits type, 7 bits length.
				const header = this.readUInt16();
				return {
					kind: 'start',
					compound: (header & 0x04) !== 0,
					type: (header >>> 3) & 0x3f,
					length: (header >>> 9) & 0x7f,
					offset,
					headerLength: 2,
				};
			}
			case 0x02: {
				// 32-bit start: 2 bits form, 1 bit compound, 14 bits type, 15 bits length.
				const header = this.readUInt32();
				const declared = (header >>> 17) & 0x7fff;
				// All ones means the length did not fit and follows as a compact integer.
				const length = declared === 0x7fff ? this.readCompactUint() : declared;
				return {
					kind: 'start',
					compound: (header & 0x04) !== 0,
					type: (header >>> 3) & 0x3fff,
					length,
					offset,
					headerLength: this.position - offset,
				};
			}
			case 0x01: {
				// 8-bit end: 2 bits form, 6 bits type.
				const header = this.readUInt8();
				return { kind: 'end', compound: false, type: header >>> 2, length: 0, offset, headerLength: 1 };
			}
			default: {
				// 16-bit end: 2 bits form, 14 bits type.
				const header = this.readUInt16();
				return { kind: 'end', compound: false, type: header >>> 2, length: 0, offset, headerLength: 2 };
			}
		}
	}
}
