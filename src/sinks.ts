import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { Sink } from './convert-file';

/** Writes under `root`, creating folders as they are first used. */
export class FsSink implements Sink {
	private made = new Set<string>();

	constructor(private root: string, private overwrite: boolean) {}

	async write(path: string, data: Uint8Array): Promise<void> {
		const full = nodePath.join(this.root, ...path.split('/'));
		const dir = nodePath.dirname(full);

		if (!this.made.has(dir)) {
			nodeFs.mkdirSync(dir, { recursive: true });
			this.made.add(dir);
		}

		// `wx` refuses to clobber a file the run did not create itself.
		nodeFs.writeFileSync(full, data, { flag: this.overwrite ? 'w' : 'wx' });
	}
}

/** Collects the tree in memory, for tests and for `--dry-run` accounting. */
export class MemorySink implements Sink {
	readonly files = new Map<string, Uint8Array>();

	async write(path: string, data: Uint8Array): Promise<void> {
		this.files.set(path, data);
	}
}

/** Counts bytes without keeping them. */
export class NullSink implements Sink {
	bytes = 0;

	async write(_path: string, data: Uint8Array): Promise<void> {
		this.bytes += data.byteLength;
	}
}
