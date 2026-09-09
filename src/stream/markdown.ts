/**
 * A note, written as it is decided rather than after it is decided.
 *
 * `PageWriter` builds an array of blocks, joins them, collapses the result and
 * trims it. The array is the problem: it is the whole note, in heap, and it has
 * to be complete before the first byte can be written because the operations
 * that finish it are global.
 *
 * They are only nearly global, though. Joining blocks needs to know whether the
 * previous one was a list item — one boolean. Merging consecutive callouts
 * needs to know the heading of the one still open — one short string. And the
 * two operations that really do span the note, collapsing newline runs and
 * trimming, are streams (see `text.ts`). What is left is a writer that holds a
 * flag, a heading and an output buffer, and hands bytes to a sink as it goes.
 *
 * The one thing it is careful about is that the front matter is not part of the
 * body. Collapsing and trimming apply to the Markdown alone, as they do in the
 * string version, so the front matter and the closing newline are written past
 * the chain rather than through it.
 */
import { ChunkWriter } from './sink';
import { NewlineCollapser, TextSpill, Trimmer } from './text';

const encoder = new TextEncoder();

/** A fixed buffer between the writer and the sink. */
export class ByteOut {
	readonly #target: ChunkWriter;
	readonly #buffer: Uint8Array;
	#length = 0;

	constructor(target: ChunkWriter, capacity = 8192) {
		this.#target = target;
		this.#buffer = new Uint8Array(capacity);
	}

	get bufferBytes(): number {
		return this.#buffer.byteLength;
	}

	async text(piece: string): Promise<void> {
		if (piece !== '') await this.bytes(encoder.encode(piece));
	}

	async bytes(chunk: Uint8Array): Promise<void> {
		if (chunk.byteLength >= this.#buffer.byteLength) {
			await this.flush();
			await this.#target.write(chunk);
			return;
		}

		if (this.#length + chunk.byteLength > this.#buffer.byteLength) await this.flush();
		this.#buffer.set(chunk, this.#length);
		this.#length += chunk.byteLength;
	}

	async flush(): Promise<void> {
		if (this.#length === 0) return;
		const pending = this.#buffer.subarray(0, this.#length);
		this.#length = 0;
		await this.#target.write(pending);
	}
}

/**
 * The block structure of one note.
 *
 * A caller opens a block, pushes its text in as many pieces as it likes, and
 * closes it. Separators, callout continuation and the quoting of callout bodies
 * are decided here, from state that does not grow.
 */
export class NoteWriter {
	readonly out: ByteOut;

	readonly #collapser: NewlineCollapser;
	readonly #trimmer: Trimmer;

	#started = false;
	#previousListItem = false;
	#openCallout: string | undefined;
	#quoting = false;

	constructor(target: ChunkWriter, trailing: TextSpill, bufferBytes = 8192) {
		this.out = new ByteOut(target, bufferBytes);
		this.#trimmer = new Trimmer(piece => this.out.text(piece), trailing);
		this.#collapser = new NewlineCollapser(piece => this.#trimmer.push(piece));
	}

	/** Text that bypasses collapsing and trimming: front matter, and the end. */
	async raw(text: string): Promise<void> {
		await this.out.text(text);
	}

	async beginBlock(listItem: boolean): Promise<void> {
		await this.#separate(listItem);
		this.#openCallout = undefined;
		this.#quoting = false;
	}

	/**
	 * Open a callout, continuing the one above if it has the same heading.
	 *
	 * A continuation is not a new block: it is appended to the one already
	 * there, which is why no separator is written and why the previous-block
	 * state is left alone.
	 */
	async beginCallout(opening: string): Promise<void> {
		if (this.#openCallout === opening) await this.#push('\n>\n');
		else {
			await this.#separate(false);
			await this.#push(`${opening}\n`);
			this.#openCallout = opening;
		}

		this.#quoting = true;
		await this.#push('> ');
	}

	/** Body text of the block that is open. */
	async push(text: string): Promise<void> {
		if (text === '') return;
		await this.#push(this.#quoting ? text.replace(/\n/g, '\n> ') : text);
	}

	async finish(): Promise<void> {
		await this.#collapser.finish();
		await this.#trimmer.finish();
		// Every note ends with exactly one newline, whether or not it has a
		// body: the trimmed Markdown never supplies one of its own.
		await this.out.text('\n');
		await this.out.flush();
	}

	async #separate(listItem: boolean): Promise<void> {
		// A run of list items is written without blank lines between them; every
		// other pair of blocks is separated by one.
		if (this.#started) await this.#push(this.#previousListItem && listItem ? '\n' : '\n\n');
		this.#previousListItem = listItem;
		this.#started = true;
	}

	async #push(text: string): Promise<void> {
		await this.#collapser.push(text);
	}
}
