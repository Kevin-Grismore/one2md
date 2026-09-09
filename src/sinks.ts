import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { Sink } from './convert-file';
import { ChunkedSink, ChunkWriter } from './stream/sink';

/** Writes under `root`, creating folders as they are first used. */
export class FsSink implements Sink, ChunkedSink {
	/**
	 * The folder the last write went to, and nothing else.
	 *
	 * `mkdirSync` with `recursive` is already idempotent, so remembering every
	 * folder ever created saves a syscall and costs an entry per folder — which
	 * for a notebook whose every page has subpages and attachments is an entry
	 * per page. One is enough: a conversion writes a note, then its assets,
	 * then the next note, so consecutive writes almost always share a folder
	 * and the run of repeats is what the saving was ever coming from.
	 */
	private lastDir: string | undefined;

	/**
	 * Files open right now, so a forced exit can delete them.
	 *
	 * A conversion holds at most two of these — the note being written and the
	 * asset being written inside it — so this is a fixed-size set rather than
	 * a growing one, and a writer removes itself on close either way.
	 *
	 * It exists because of what a second Ctrl-C does. The first asks the
	 * conversion to stop, and the ordinary unwinding aborts the note in
	 * progress. The second does not wait to be asked: it calls `process.exit`,
	 * nothing unwinds, and whatever was open stays on disk as a file that
	 * looks like a note and is half of one. Nothing else can clean those up,
	 * because by then there is no stack left to do it from.
	 */
	private readonly openWriters = new Set<{ abort: () => void }>();

	constructor(private root: string, private overwrite: boolean) {}

	async write(path: string, data: Uint8Array): Promise<void> {
		nodeFs.writeFileSync(this.prepare(path), data, { flag: this.flag });
	}

	/**
	 * The bounded path: bytes go to the descriptor as they arrive.
	 *
	 * This is what keeps an attachment's size off the heap. The same `wx` rule
	 * applies, and it applies at open — so a run that would clobber a file it
	 * did not create fails before anything is written rather than partway
	 * through.
	 */
	async open(path: string): Promise<ChunkWriter> {
		const full = this.prepare(path);
		const descriptor = nodeFs.openSync(full, this.flag);
		const sink = this;
		let position = 0;
		// One flag for both endings, so closing twice, aborting after closing
		// and being caught by `abortAll` on the way out are all no-ops rather
		// than a double close of a descriptor that may have been reused.
		let settled = false;

		const entry = {
			abort(): void {
				if (settled) return;
				settled = true;
				sink.openWriters.delete(entry);
				try {
					nodeFs.closeSync(descriptor);
				}
				finally {
					nodeFs.rmSync(full, { force: true });
				}
			},
		};

		this.openWriters.add(entry);

		return {
			async write(chunk: Uint8Array): Promise<void> {
				let written = 0;
				while (written < chunk.byteLength) {
					written += nodeFs.writeSync(descriptor, chunk, written, chunk.byteLength - written, position + written);
				}
				position += chunk.byteLength;
			},
			async close(): Promise<void> {
				if (settled) return;
				settled = true;
				sink.openWriters.delete(entry);
				nodeFs.closeSync(descriptor);
			},
			async abort(): Promise<void> {
				entry.abort();
			},
		};
	}

	/**
	 * Abandon and delete every file still open, without waiting to be asked.
	 *
	 * For the exit that does not unwind. Synchronous on purpose: an `exit`
	 * handler and a second signal both run with no opportunity to await, so a
	 * promise here would resolve after the process was gone.
	 *
	 * Idempotent, and safe to call after everything has closed normally — in
	 * which case there is nothing left in the set and it does nothing.
	 */
	abortAll(): void {
		// Copied because aborting removes from the set being walked, and the
		// copy is of a set that holds at most a couple of entries.
		for (const entry of [...this.openWriters]) {
			try {
				entry.abort();
			}
			catch {
				// One file that will not close should not stop the next one
				// being deleted; the caller is on its way out either way.
			}
		}

		this.openWriters.clear();
	}

	/** Files this sink still has open. For the tests, and for asserting zero. */
	get openCount(): number {
		return this.openWriters.size;
	}

	private get flag(): string {
		// `wx` refuses to clobber a file the run did not create itself.
		return this.overwrite ? 'w' : 'wx';
	}

	private prepare(path: string): string {
		const full = nodePath.join(this.root, ...path.split('/'));
		const dir = nodePath.dirname(full);

		if (dir !== this.lastDir) {
			nodeFs.mkdirSync(dir, { recursive: true });
			this.lastDir = dir;
		}

		return full;
	}
}

/**
 * Collects the tree in memory, for tests and for `--dry-run` accounting.
 *
 * Holding the whole tree is this sink's purpose, so opening one is not a way
 * to avoid that — it is only a way to hand it the bytes in pieces.
 */
export class MemorySink implements Sink, ChunkedSink {
	readonly files = new Map<string, Uint8Array>();

	async write(path: string, data: Uint8Array): Promise<void> {
		this.files.set(path, data);
	}

	async open(path: string): Promise<ChunkWriter> {
		const files = this.files;
		let pieces: Uint8Array[] = [];
		let length = 0;

		return {
			async write(chunk: Uint8Array): Promise<void> {
				if (chunk.byteLength === 0) return;
				// A chunk can be a view into a reader's buffer, which the next
				// read overwrites, so what is kept has to be a copy.
				pieces.push(chunk.slice());
				length += chunk.byteLength;
			},
			async close(): Promise<void> {
				const whole = new Uint8Array(length);
				let at = 0;
				for (const piece of pieces) {
					whole.set(piece, at);
					at += piece.byteLength;
				}
				pieces = [];
				files.set(path, whole);
			},
			async abort(): Promise<void> {
				pieces = [];
			},
		};
	}
}

/** Counts bytes without keeping them. */
export class NullSink implements Sink, ChunkedSink {
	bytes = 0;
	/** Files completed. An aborted one is not one, so it is not counted. */
	files = 0;

	async write(_path: string, data: Uint8Array): Promise<void> {
		this.bytes += data.byteLength;
		this.files++;
	}

	async open(_path: string): Promise<ChunkWriter> {
		const sink = this;
		return {
			async write(chunk: Uint8Array): Promise<void> {
				sink.bytes += chunk.byteLength;
			},
			async close(): Promise<void> {
				sink.files++;
			},
			async abort(): Promise<void> {},
		};
	}
}
