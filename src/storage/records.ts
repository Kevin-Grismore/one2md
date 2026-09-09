import { ByteRange } from './byte-source';

/**
 * Fixed-layout binary records, for the keys and values a paged store holds.
 *
 * Everything an index persists is a small struct of offsets, counts and
 * identifiers, and it has to survive a round trip through byte arrays. Writing
 * that by hand at each call site is exactly where a field-order mistake hides,
 * so it goes through one writer and one reader whose methods pair up by name
 * and are meant to be read side by side.
 *
 * A GUID is stored as its canonical 36-character text rather than its sixteen
 * bytes. That costs twenty bytes of temporary disk per GUID and removes a
 * byte-order conversion which would have to agree with two different readers'
 * idea of it — the desktop and packaged encodings do not lay a GUID out the
 * same way, and both already hand this layer the same normalized string.
 */

const GUID_TEXT_LENGTH = 36;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class RecordError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'RecordError';
		this.code = code;
	}
}

/** An identifier as both encodings express it, once normalized. */
export interface RecordGuid {
	identifier: string;
	value: number;
}

/**
 * Builds one record into a buffer it reuses.
 *
 * `done()` returns a view of the bytes written so far, valid until the next
 * `reset()`. A `PagedKeyValueStore` copies both key and value on the way in, so
 * one writer per role — one for keys, one for values — allocates nothing per
 * record however many are written.
 */
export class RecordWriter {
	#buffer: Uint8Array;
	#view: DataView;
	#length = 0;

	constructor(capacity = 128) {
		this.#buffer = new Uint8Array(Math.max(capacity, 8));
		this.#view = new DataView(this.#buffer.buffer);
	}

	get length(): number {
		return this.#length;
	}

	/** Starts a new record, optionally opening it with a namespace tag. */
	reset(tag?: number): this {
		this.#length = 0;
		return tag === undefined ? this : this.u8(tag);
	}

	done(): Uint8Array {
		return this.#buffer.subarray(0, this.#length);
	}

	// Every one of these takes the offset into a local first. `#room` may grow
	// the record, which replaces both the buffer and the view over it, and an
	// argument is evaluated only after the callee has been resolved — so
	// passing `#room(...)` straight to `this.#view` writes into the old view.

	u8(value: number): this {
		const at = this.#room(1);
		this.#view.setUint8(at, value & 0xff);
		return this;
	}

	u16(value: number): this {
		const at = this.#room(2);
		this.#view.setUint16(at, value & 0xffff, true);
		return this;
	}

	u32(value: number): this {
		const at = this.#room(4);
		this.#view.setUint32(at, value >>> 0, true);
		return this;
	}

	i32(value: number): this {
		const at = this.#room(4);
		this.#view.setInt32(at, value | 0, true);
		return this;
	}

	flag(value: boolean): this {
		return this.u8(value ? 1 : 0);
	}

	/** A file offset or byte count, exact across the whole safe-integer range. */
	big(value: number): this {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new RecordError(
				'RECORD_VALUE_RANGE',
				`A record offset or count must be a non-negative safe integer; received ${value}.`);
		}
		const at = this.#room(8);
		this.#view.setUint32(at, value % 0x100000000, true);
		this.#view.setUint32(at + 4, Math.floor(value / 0x100000000), true);
		return this;
	}

	optionalBig(value: number | undefined): this {
		return value === undefined ? this.flag(false) : this.flag(true).big(value);
	}

	/**
	 * A number stored without loss.
	 *
	 * Coordinates and widths reach the output as `${value}`, so anything that
	 * rounds them changes what is written. This is the one field type that
	 * exists to preserve a value exactly rather than compactly.
	 */
	f64(value: number): this {
		const at = this.#room(8);
		this.#view.setFloat64(at, value, true);
		return this;
	}

	range(value: ByteRange): this {
		return this.big(value.offset).big(value.length);
	}

	optionalRange(value: ByteRange | undefined): this {
		return value === undefined ? this.flag(false) : this.flag(true).range(value);
	}

	guid(value: string): this {
		if (value.length !== GUID_TEXT_LENGTH) {
			throw new RecordError(
				'RECORD_GUID_LENGTH',
				`A record GUID must be ${GUID_TEXT_LENGTH} characters; received ${JSON.stringify(value)}.`);
		}
		const at = this.#room(GUID_TEXT_LENGTH);
		for (let index = 0; index < GUID_TEXT_LENGTH; index++) {
			this.#buffer[at + index] = value.charCodeAt(index);
		}
		return this;
	}

	extendedGuid(value: RecordGuid): this {
		return this.guid(value.identifier).u32(value.value);
	}

	optionalExtendedGuid(value: RecordGuid | undefined): this {
		return value === undefined ? this.flag(false) : this.flag(true).extendedGuid(value);
	}

	text(value: string): this {
		const bytes = encoder.encode(value);
		this.u32(bytes.byteLength);
		return this.bytes(bytes);
	}

	optionalText(value: string | undefined): this {
		return value === undefined ? this.flag(false) : this.flag(true).text(value);
	}

	bytes(value: Uint8Array): this {
		// `#room` can replace the buffer, and an argument is evaluated after the
		// callee it is passed to has been resolved — so the offset has to be
		// taken before `set` is reached, or it writes into the old one.
		const at = this.#room(value.byteLength);
		this.#buffer.set(value, at);
		return this;
	}

	#room(bytes: number): number {
		const at = this.#length;
		const needed = at + bytes;

		if (needed > this.#buffer.byteLength) {
			let capacity = this.#buffer.byteLength;
			while (capacity < needed) capacity *= 2;
			const grown = new Uint8Array(capacity);
			grown.set(this.#buffer.subarray(0, at));
			this.#buffer = grown;
			this.#view = new DataView(grown.buffer);
		}

		this.#length = needed;
		return at;
	}
}

/** Reads a record back, in the order it was written. */
export class RecordReader {
	readonly data: Uint8Array;
	#view: DataView;
	#position: number;

	constructor(data: Uint8Array, start = 0) {
		this.data = data;
		this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		this.#position = start;
	}

	get position(): number {
		return this.#position;
	}

	get atEnd(): boolean {
		return this.#position >= this.data.byteLength;
	}

	u8(): number {
		return this.#view.getUint8(this.#take(1));
	}

	u16(): number {
		return this.#view.getUint16(this.#take(2), true);
	}

	u32(): number {
		return this.#view.getUint32(this.#take(4), true);
	}

	i32(): number {
		return this.#view.getInt32(this.#take(4), true);
	}

	flag(): boolean {
		return this.u8() !== 0;
	}

	f64(): number {
		return this.#view.getFloat64(this.#take(8), true);
	}

	big(): number {
		const at = this.#take(8);
		const value = this.#view.getUint32(at + 4, true) * 0x100000000 + this.#view.getUint32(at, true);
		if (!Number.isSafeInteger(value)) {
			throw new RecordError('RECORD_CORRUPT', 'A stored offset or count is outside the safe-integer range.');
		}
		return value;
	}

	optionalBig(): number | undefined {
		return this.flag() ? this.big() : undefined;
	}

	range(): ByteRange {
		return { offset: this.big(), length: this.big() };
	}

	optionalRange(): ByteRange | undefined {
		return this.flag() ? this.range() : undefined;
	}

	guid(): string {
		const at = this.#take(GUID_TEXT_LENGTH);
		return decoder.decode(this.data.subarray(at, at + GUID_TEXT_LENGTH));
	}

	extendedGuid(): RecordGuid {
		return { identifier: this.guid(), value: this.u32() };
	}

	optionalExtendedGuid(): RecordGuid | undefined {
		return this.flag() ? this.extendedGuid() : undefined;
	}

	text(): string {
		const length = this.u32();
		const at = this.#take(length);
		return decoder.decode(this.data.subarray(at, at + length));
	}

	optionalText(): string | undefined {
		return this.flag() ? this.text() : undefined;
	}

	#take(bytes: number): number {
		const at = this.#position;
		if (bytes < 0 || at + bytes > this.data.byteLength) {
			throw new RecordError(
				'RECORD_TRUNCATED',
				`A stored record ended after ${this.data.byteLength} bytes while reading ${bytes} more at ${at}.`);
		}
		this.#position = at + bytes;
		return at;
	}
}
