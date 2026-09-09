import { ByteSource, ByteSourceError } from './byte-source';

/** One window holds this many bytes unless a caller asks for another size. */
export const DEFAULT_WINDOW_BYTES = 64 * 1024;

/**
 * A single sliding buffer over a `ByteSource`.
 *
 * Structural parsing reads a handful of bytes at a time — a fragment header, a
 * file-node header, a stream object header — and going to the descriptor for
 * each of those costs a system call per field. The window turns them into one
 * read per `capacity` bytes while keeping resident memory constant: there is
 * exactly one buffer, and its size does not depend on the file's.
 *
 * `peek` hands back a view into that one buffer, so it is valid only until the
 * next call on the same window. `read` copies, and is what a caller keeps.
 */
export class ByteWindow {
	readonly source: ByteSource;
	readonly capacity: number;

	#buffer = new Uint8Array(0);
	#start = 0;
	#refills = 0;

	constructor(source: ByteSource, capacity: number = DEFAULT_WINDOW_BYTES) {
		if (!Number.isSafeInteger(capacity) || capacity <= 0) {
			throw new ByteSourceError(
				'BYTE_WINDOW_INVALID_CAPACITY',
				`A byte window capacity must be a positive safe integer; received ${capacity}.`);
		}
		this.source = source;
		this.capacity = capacity;
	}

	get size(): number {
		return this.source.size;
	}

	/** Bytes held resident, which never exceeds one window. */
	get residentBytes(): number {
		return this.#buffer.byteLength;
	}

	/** How many times the window has gone to the source. */
	get refills(): number {
		return this.#refills;
	}

	/** Bytes valid only until the next call on this window. */
	peek(offset: number, length: number): Uint8Array {
		if (length > this.capacity) {
			throw new ByteSourceError(
				'BYTE_WINDOW_TOO_LARGE',
				`A ${length}-byte peek exceeds the ${this.capacity}-byte window; read an owned copy instead.`,
				offset,
				length);
		}

		const from = offset - this.#start;
		// Written as a positive test so a non-finite offset refills rather than
		// slipping through as an empty subarray.
		if (from >= 0 && from + length <= this.#buffer.byteLength) {
			return this.#buffer.subarray(from, from + length);
		}

		return this.#refill(offset, length);
	}

	/** An owned copy, of any length the source can supply. */
	read(offset: number, length: number): Uint8Array {
		if (length > this.capacity) return this.source.read(offset, length);
		return this.peek(offset, length).slice();
	}

	#refill(offset: number, length: number): Uint8Array {
		// Delegating the bounds check leaves one place that decides what a bad
		// range is and which error it raises.
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
			|| offset < 0 || length < 0 || offset > this.source.size - length) {
			this.source.read(offset, length);
		}

		const span = Math.min(this.capacity, this.source.size - offset);
		this.#buffer = this.source.read(offset, span);
		this.#start = offset;
		this.#refills++;

		return this.#buffer.subarray(0, length);
	}
}
