import * as nodeFs from 'node:fs';

export class ByteSourceError extends Error {
	readonly code: string;
	readonly offset?: number;
	readonly length?: number;

	constructor(code: string, message: string, offset?: number, length?: number) {
		super(message);
		this.name = 'ByteSourceError';
		this.code = code;
		this.offset = offset;
		this.length = length;
	}
}

/**
 * A random-access byte sequence. Reads are positional: they never depend on or
 * change a shared cursor, and the returned bytes are owned by the caller.
 */
export interface ByteSource {
	readonly size: number;
	read(offset: number, length: number): Uint8Array;
}

/**
 * A span of a `ByteSource`, named rather than materialized.
 *
 * This is the unit an index stores in place of bytes: it is fixed-size, so
 * holding one per structure costs the same whatever the structure contains,
 * and the bytes are fetched only if something actually needs them.
 */
export interface ByteRange {
	offset: number;
	length: number;
}

function checkRead(size: number, offset: number, length: number): void {
	if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
		throw new ByteSourceError(
			'BYTE_SOURCE_INVALID_RANGE',
			`ByteSource reads require safe-integer offsets and lengths; received offset ${offset}, length ${length}.`,
			offset,
			length);
	}
	if (offset < 0 || length < 0 || offset > size - length) {
		throw new ByteSourceError(
			'BYTE_SOURCE_OUT_OF_BOUNDS',
			`Cannot read ${length} bytes at offset ${offset} from a ${size}-byte source.`,
			offset,
			length);
	}
}

export class Uint8ArrayByteSource implements ByteSource {
	readonly size: number;
	readonly #data: Uint8Array;

	constructor(data: Uint8Array) {
		this.#data = data;
		this.size = data.byteLength;
	}

	read(offset: number, length: number): Uint8Array {
		checkRead(this.size, offset, length);
		return this.#data.slice(offset, offset + length);
	}
}

/**
 * A source over an already-open descriptor. The descriptor remains owned by
 * the caller, and its current file position is never observed or changed.
 */
export class FileDescriptorByteSource implements ByteSource {
	readonly size: number;
	readonly #fd: number;

	constructor(fd: number, size = nodeFs.fstatSync(fd).size) {
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new ByteSourceError(
				'BYTE_SOURCE_INVALID_SIZE',
				`File descriptor ByteSource size must be a non-negative safe integer; received ${size}.`);
		}
		this.#fd = fd;
		this.size = size;
	}

	read(offset: number, length: number): Uint8Array {
		checkRead(this.size, offset, length);
		const result = new Uint8Array(length);
		let read = 0;

		while (read < length) {
			const count = nodeFs.readSync(this.#fd, result, read, length - read, offset + read);
			if (count === 0) {
				throw new ByteSourceError(
					'BYTE_SOURCE_SHORT_READ',
					`File descriptor ended after ${read} of ${length} requested bytes at offset ${offset}; the file may have been truncated after the source was opened.`,
					offset,
					length);
			}
			read += count;
		}

		return result;
	}
}
