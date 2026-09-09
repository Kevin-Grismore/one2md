/**
 * Sequences that outlive the budget they are allowed to occupy.
 *
 * The index solved the problem of a section too large to hold. Converting one
 * raises the mirror image: things the conversion itself produces — a note's
 * markdown, an ink drawing's points, the list of names already claimed — are
 * proportional to the input and would be held in heap for as long as the page,
 * the section or the batch lasts.
 *
 * A spool is the answer to that. It is written once and read back in order, and
 * only one chunk of it is ever in memory: the rest is in the paged store, which
 * means on disk under a byte budget. Both flavours below share that property
 * and differ only in what a chunk is — a run of bytes, or one fixed record.
 *
 * Neither owns its store. A spool is a region inside one, named by a tag and an
 * identifier, so a whole conversion shares a single store, a single page cache
 * and therefore a single budget.
 */
import { PagedKeyValueStore } from './paged-key-value-store';
import { RecordWriter } from './records';

export class SpoolError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'SpoolError';
		this.code = code;
	}
}

/**
 * How much of a spool is in memory at once.
 *
 * Small enough that a page of the default size holds a chunk with room to
 * spare, since a record has to fit inside one page.
 */
export const DEFAULT_CHUNK_BYTES = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * An append-only byte stream, spilled to the store a chunk at a time.
 *
 * Writing is unbounded; the resident cost is one chunk. Reading replays the
 * chunks in the order they were written, so a consumer sees exactly the byte
 * sequence that was appended — the chunk boundaries are not meaningful and a
 * caller should not assume anything about where they fall.
 */
export class ByteSpool {
	readonly chunkBytes: number;

	readonly #store: PagedKeyValueStore;
	readonly #tag: number;
	readonly #id: number;
	readonly #key = new RecordWriter(16);

	#pending: Uint8Array;
	#pendingLength = 0;
	#chunks = 0;
	#length = 0;

	constructor(store: PagedKeyValueStore, tag: number, id: number, chunkBytes = DEFAULT_CHUNK_BYTES) {
		this.#store = store;
		this.#tag = tag;
		this.#id = id;
		this.chunkBytes = chunkBytes;
		this.#pending = new Uint8Array(chunkBytes);
	}

	/** Bytes appended so far. */
	get length(): number {
		return this.#length;
	}

	get isEmpty(): boolean {
		return this.#length === 0;
	}

	/** Bytes held in memory rather than in the store. */
	get residentBytes(): number {
		return this.#pending.byteLength;
	}

	write(bytes: Uint8Array): void {
		let written = 0;

		while (written < bytes.byteLength) {
			const room = this.chunkBytes - this.#pendingLength;
			const take = Math.min(room, bytes.byteLength - written);

			this.#pending.set(bytes.subarray(written, written + take), this.#pendingLength);
			this.#pendingLength += take;
			this.#length += take;
			written += take;

			if (this.#pendingLength === this.chunkBytes) this.#flush();
		}
	}

	/**
	 * Append text as UTF-8.
	 *
	 * The encoded bytes of the argument are transient, so this is bounded by the
	 * caller's string rather than by the spool: append in pieces to keep it so.
	 */
	writeText(text: string): void {
		if (text !== '') this.write(encoder.encode(text));
	}

	/** The bytes, in the order they were written. */
	*chunks(): IterableIterator<Uint8Array> {
		for (let index = 0; index < this.#chunks; index++) {
			const stored = this.#store.get(this.#chunkKey(index));
			if (!stored) {
				throw new SpoolError(
					'SPOOL_MISSING_CHUNK',
					`Chunk ${index} of ${this.#chunks} is not in the store; the spool was reset or its store was reused.`);
			}
			yield stored;
		}

		if (this.#pendingLength > 0) yield this.#pending.subarray(0, this.#pendingLength);
	}

	/**
	 * The bytes as text, decoded across chunk boundaries.
	 *
	 * A chunk can end in the middle of a UTF-8 sequence, so this is the only
	 * safe way to read text back: decoding each chunk on its own would corrupt
	 * whatever character the boundary fell inside.
	 */
	*text(): IterableIterator<string> {
		const streaming = new TextDecoder();
		for (const chunk of this.chunks()) {
			const piece = streaming.decode(chunk, { stream: true });
			if (piece !== '') yield piece;
		}

		const tail = streaming.decode();
		if (tail !== '') yield tail;
	}

	/** The whole spool as one string. Only for a spool known to be small. */
	readAllText(): string {
		if (this.#chunks === 0) return decoder.decode(this.#pending.subarray(0, this.#pendingLength));

		let value = '';
		for (const piece of this.text()) value += piece;
		return value;
	}

	/** Forget everything written, so the region can be used again. */
	reset(): void {
		this.#pendingLength = 0;
		this.#chunks = 0;
		this.#length = 0;
	}

	#flush(): void {
		this.#store.set(this.#chunkKey(this.#chunks), this.#pending.subarray(0, this.#pendingLength));
		this.#chunks++;
		this.#pendingLength = 0;
	}

	#chunkKey(index: number): Uint8Array {
		return this.#key.reset(this.#tag).u32(this.#id).u32(index).done();
	}
}

/**
 * An append-only list of records, addressed by position.
 *
 * This is the disk-backed replacement for an array that grows with the input:
 * one ink stroke per entry, one point, one report line. Records are written
 * whole, so each has to fit in a page — which the store enforces.
 */
export class RecordSpool {
	readonly #store: PagedKeyValueStore;
	readonly #tag: number;
	readonly #id: number;
	readonly #key = new RecordWriter(16);

	#count = 0;

	constructor(store: PagedKeyValueStore, tag: number, id: number) {
		this.#store = store;
		this.#tag = tag;
		this.#id = id;
	}

	get count(): number {
		return this.#count;
	}

	get isEmpty(): boolean {
		return this.#count === 0;
	}

	/** Appends a record and answers with its position. */
	push(value: Uint8Array): number {
		const position = this.#count++;
		this.#store.set(this.#entryKey(position), value);
		return position;
	}

	at(position: number): Uint8Array {
		const stored = this.#store.get(this.#entryKey(position));
		if (!stored) {
			throw new SpoolError(
				'SPOOL_MISSING_RECORD',
				`Record ${position} of ${this.#count} is not in the store; the spool was reset or its store was reused.`);
		}
		return stored;
	}

	*values(): IterableIterator<Uint8Array> {
		for (let position = 0; position < this.#count; position++) yield this.at(position);
	}

	reset(): void {
		this.#count = 0;
	}

	#entryKey(position: number): Uint8Array {
		return this.#key.reset(this.#tag).u32(this.#id).u32(position).done();
	}
}
