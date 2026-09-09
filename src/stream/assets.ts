/**
 * Attachments, copied rather than loaded.
 *
 * An embedded file in a OneNote section is a span of the section: converting it
 * means reading those bytes and writing them somewhere else. `saveAttachment`
 * does that with a `Uint8Array`, so a fifty-megabyte video is fifty megabytes
 * of heap for as long as it takes to hash it, name it and write it — and
 * `maxAssetBytes` defaults to sixty-four, per attachment.
 *
 * None of the three things done to those bytes needs them all at once. A digest
 * is a streaming hash. A file-type sniff looks at the first twelve bytes. A
 * copy is a copy. So an attachment arrives here as a `ByteStream` — something
 * that can be read through more than once — and the resident cost is one chunk
 * of it whatever its size.
 */
import { createHash } from 'node:crypto';

import { sanitizeFileName } from '../names';
import { extensionFromBytes, extensionFromName } from '../onenote-file/util';
import { ByteRange } from '../storage/byte-source';
import { ByteWindow } from '../storage/byte-window';
import { ByteSpool } from '../storage/spool';
import { RangeReader } from '../resolve/range-reader';
import { ChunkedSink } from './sink';
import { StreamedAttachment, StreamWorkspace } from './workspace';

/** Bytes that can be read through as many times as needed, in pieces. */
export interface ByteStream {
	readonly length: number;
	chunks(): IterableIterator<Uint8Array>;
}

/** A span of the section being converted. */
export function rangeStream(window: ByteWindow, range: ByteRange): ByteStream {
	return {
		length: range.length,
		*chunks(): IterableIterator<Uint8Array> {
			yield* new RangeReader(window, range).steps();
		},
	};
}

/** Bytes the conversion generated, such as an ink drawing. */
export function spoolStream(spool: ByteSpool): ByteStream {
	return {
		get length(): number {
			return spool.length;
		},
		chunks: () => spool.chunks(),
	};
}

/** How many bytes a file-type sniff needs; the longest signature is twelve. */
const SNIFF_BYTES = 12;

function head(stream: ByteStream, count: number): Uint8Array {
	const bytes = new Uint8Array(Math.min(count, stream.length));
	let at = 0;

	for (const chunk of stream.chunks()) {
		if (at >= bytes.byteLength) break;
		const take = Math.min(chunk.byteLength, bytes.byteLength - at);
		bytes.set(chunk.subarray(0, take), at);
		at += take;
	}

	return bytes;
}

export interface AssetOptions {
	writeAttachments: boolean;
}

export class AssetWriter {
	constructor(
		private readonly sink: ChunkedSink,
		private readonly workspace: StreamWorkspace,
		private readonly options: AssetOptions,
	) {}

	/**
	 * Write one attachment, or answer with the one already written for it.
	 *
	 * Identical bytes appear repeatedly across a notebook — the same logo on
	 * every page — and one copy is enough, so the digest decides before a name
	 * is claimed. The digest is taken by reading the stream through once; the
	 * copy reads it again. Neither holds it.
	 */
	async save(
		stream: ByteStream,
		suggested: string,
		attachmentsDir: string,
		linkPrefix: string,
	): Promise<StreamedAttachment | null> {
		if (!this.options.writeAttachments) return null;

		// OneNote often stores an image with no name at all; its bytes say what
		// it is.
		let name = suggested;
		if (!extensionFromName(name)) {
			const sniffed = extensionFromBytes(head(stream, SNIFF_BYTES));
			if (sniffed) name = `${name}.${sniffed}`;
		}

		const hash = createHash('sha256');
		for (const chunk of stream.chunks()) hash.update(chunk);
		const digest = hash.digest('hex');

		const existing = this.workspace.writtenFor(attachmentsDir, digest);
		if (existing) return existing;

		const fileName = this.workspace.claim(attachmentsDir, sanitizeFileName(name));
		const path = join(attachmentsDir, fileName);

		const writer = await this.sink.open(path);
		try {
			for (const chunk of stream.chunks()) await writer.write(chunk);
			await writer.close();
		}
		catch (error) {
			await writer.abort?.();
			throw error;
		}

		this.workspace.recordAttachment(path);

		// The link is resolved from the note, which sits one level above the
		// folder.
		const resolved: StreamedAttachment = { path: join(linkPrefix, fileName), name: fileName };
		this.workspace.rememberContent(attachmentsDir, digest, resolved);
		return resolved;
	}
}

export function join(...parts: (string | undefined)[]): string {
	return parts.filter(part => part !== undefined && part !== '').join('/');
}
