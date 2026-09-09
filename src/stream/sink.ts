/**
 * Writing a file without having it.
 *
 * `Sink.write(path, data)` needs the whole file as one array, which is fine for
 * a note of two kilobytes and impossible for a fifty-megabyte attachment that
 * is only ever going to be copied from one place to another. Every byte of it
 * has to exist at once, in heap, on the way through.
 *
 * So a sink can now also be opened. `open` hands back something that accepts
 * chunks and is closed at the end, which lets an attachment be copied a window
 * at a time and a note be written as it is rendered. The old method stays
 * exactly as it was: it is what the Obsidian plugin implements, it is what the
 * tests collect trees with, and a sink that only has it still works — through
 * the adapter below, which is honest about what it costs.
 */
import { Sink } from '../convert-file';

/** An output file that is open, and accepts its contents in pieces. */
export interface ChunkWriter {
	write(chunk: Uint8Array): Promise<void>;
	/** Completes the file. A writer is not usable afterwards. */
	close(): Promise<void>;
	/**
	 * Abandons the file, if the sink can. A sink that cannot is entitled to
	 * leave what was written; the conversion reports the failure either way.
	 */
	abort?(): Promise<void>;
}

export interface ChunkedSink extends Sink {
	open(path: string): Promise<ChunkWriter>;
}

export function isChunkedSink(sink: Sink): sink is ChunkedSink {
	return typeof (sink as ChunkedSink).open === 'function';
}

/**
 * A chunked view of a sink that only takes whole files.
 *
 * The chunks are collected and handed over at `close`, so this is the one place
 * in the bounded pipeline that holds a whole output file — there is nowhere
 * else for it to go when the only way in takes an array. It exists so that a
 * caller with an existing `Sink` still works rather than being turned away, and
 * `isChunkedSink` is how a caller checks whether it is about to pay for it.
 */
class BufferedChunkWriter implements ChunkWriter {
	readonly #sink: Sink;
	readonly #path: string;
	readonly #pieces: Uint8Array[] = [];

	#length = 0;
	#closed = false;

	constructor(sink: Sink, path: string) {
		this.#sink = sink;
		this.#path = path;
	}

	async write(chunk: Uint8Array): Promise<void> {
		if (this.#closed) throw new Error(`${this.#path} was written to after it was closed.`);
		if (chunk.byteLength === 0) return;

		// Copied, because a chunk can be a view into a reader's own buffer and
		// the next read would change what it holds.
		this.#pieces.push(chunk.slice());
		this.#length += chunk.byteLength;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;

		const whole = new Uint8Array(this.#length);
		let at = 0;
		for (const piece of this.#pieces) {
			whole.set(piece, at);
			at += piece.byteLength;
		}
		this.#pieces.length = 0;

		await this.#sink.write(this.#path, whole);
	}

	async abort(): Promise<void> {
		this.#closed = true;
		this.#pieces.length = 0;
	}
}

/** Use a sink chunk-wise, natively when it can and by buffering when it cannot. */
export function asChunkedSink(sink: Sink): ChunkedSink {
	if (isChunkedSink(sink)) return sink;

	return {
		write: (path, data) => sink.write(path, data),
		open: async path => new BufferedChunkWriter(sink, path),
	};
}
