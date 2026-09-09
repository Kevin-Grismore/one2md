/**
 * The string operations a conversion performs, performed on a stream.
 *
 * Rendering a note is a chain of transformations over its text: carriage
 * returns become newlines, the whole thing is trimmed, runs of three or more
 * newlines collapse to two, each line is escaped where Markdown would
 * reinterpret it. Written against strings — which is how `convert.ts` writes
 * them — every one of those needs the text it operates on to exist whole.
 *
 * Every one of them is also local. Collapsing newlines needs a count, not the
 * text; trimming needs to know whether any non-whitespace has been seen, and to
 * hold back a run of trailing whitespace until it knows whether more is coming.
 * So each becomes a small state machine here, and the state is a few numbers
 * plus, in one case, a buffer that goes to disk when it grows.
 *
 * The output has to be identical to the string version's, byte for byte, which
 * is why these are written as transliterations rather than as improvements.
 * Where a JavaScript operation has a subtlety — `trim` removing more than ASCII
 * whitespace, `#{1,6}` refusing to match seven hashes — the subtlety is
 * reproduced rather than approximated.
 */
import { ByteSpool } from '../storage/spool';

/** How much text a spill holds before the rest goes to the store. */
export const DEFAULT_SPILL_BUDGET = 64 * 1024;

/**
 * Exactly the set JavaScript's `\s` and `String.prototype.trim` share.
 *
 * Both use WhiteSpace ∪ LineTerminator, which is wider than ASCII: a note
 * ending in a non-breaking space or a byte-order mark is trimmed by the string
 * version, so it has to be trimmed here too.
 */
const WHITESPACE = new Set([
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
	0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
	0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

export function isWhitespace(code: number): boolean {
	return WHITESPACE.has(code);
}

/**
 * Text that is accumulated, then read back — possibly more than once.
 *
 * Held in a string while it stays inside the budget, and in the store after
 * that. A caller sees the same sequence of pieces either way, so nothing above
 * has to know which side of the budget a given piece of text fell on.
 */
export class TextSpill {
	readonly budget: number;

	readonly #spool: ByteSpool;
	#head = '';
	#spilled = false;
	#length = 0;

	constructor(spool: ByteSpool, budget = DEFAULT_SPILL_BUDGET) {
		this.#spool = spool;
		this.budget = budget;
	}

	/** Length in UTF-16 code units, as `String.length` counts. */
	get length(): number {
		return this.#length;
	}

	get isEmpty(): boolean {
		return this.#length === 0;
	}

	/** Whether the text outgrew its budget and went to disk. */
	get spilled(): boolean {
		return this.#spilled;
	}

	append(text: string): void {
		if (text === '') return;
		this.#length += text.length;

		if (!this.#spilled && this.#head.length + text.length <= this.budget) {
			this.#head += text;
			return;
		}

		if (!this.#spilled) {
			this.#spool.reset();
			this.#spool.writeText(this.#head);
			this.#head = '';
			this.#spilled = true;
		}

		this.#spool.writeText(text);
	}

	/** The text in pieces, in order. Re-readable as often as needed. */
	*pieces(): IterableIterator<string> {
		if (this.#spilled) yield* this.#spool.text();
		else if (this.#head !== '') yield this.#head;
	}

	clear(): void {
		this.#head = '';
		this.#length = 0;
		if (this.#spilled) this.#spool.reset();
		this.#spilled = false;
	}
}

/** Where transformed text goes. Returning a promise is allowed but not usual. */
export type TextEmit = (piece: string) => void | Promise<void>;

/**
 * `text.replace(/\r\n?/g, '\n')`, one piece at a time.
 *
 * A lone carriage return becomes a newline and a CRLF pair becomes one, which
 * means a CR at the end of a piece cannot be decided until the next piece
 * arrives — hence the one character of held state.
 */
export class CarriageReturnFilter {
	#pendingReturn = false;

	constructor(private readonly emit: TextEmit) {}

	async push(piece: string): Promise<void> {
		let out = '';

		for (let index = 0; index < piece.length; index++) {
			const character = piece[index];

			if (this.#pendingReturn) {
				this.#pendingReturn = false;
				// The newline of a CRLF pair was already emitted as one.
				if (character === '\n') continue;
			}

			if (character === '\r') {
				this.#pendingReturn = true;
				out += '\n';
				continue;
			}

			out += character;
		}

		if (out !== '') await this.emit(out);
	}

	async finish(): Promise<void> {
		this.#pendingReturn = false;
	}
}

/**
 * `String.prototype.trim`, over a stream.
 *
 * The leading half needs one flag. The trailing half cannot know whether a run
 * of whitespace is trailing until either a non-whitespace character arrives or
 * the stream ends, so the run is held — in a spill, because a note could end
 * with a great deal of it and holding that in heap would be the very thing
 * being avoided.
 */
export class Trimmer {
	#seenContent = false;

	constructor(private readonly emit: TextEmit, private readonly pending: TextSpill) {}

	async push(piece: string): Promise<void> {
		let start = 0;

		if (!this.#seenContent) {
			while (start < piece.length && isWhitespace(piece.charCodeAt(start))) start++;
			if (start === piece.length) return;
			this.#seenContent = true;
		}

		// Everything after the last non-whitespace character in this piece may
		// yet turn out to be trailing, so it joins whatever is already held.
		let end = piece.length;
		while (end > start && isWhitespace(piece.charCodeAt(end - 1))) end--;

		if (end > start) {
			for (const held of this.pending.pieces()) await this.emit(held);
			this.pending.clear();
			await this.emit(piece.slice(start, end));
		}

		if (end < piece.length) this.pending.append(piece.slice(end));
	}

	async finish(): Promise<void> {
		// Whatever is still held was trailing after all.
		this.pending.clear();
	}
}

/**
 * `text.replace(/\n{3,}/g, '\n\n')`, over a stream.
 *
 * A run of newlines is a number until something else arrives, so this is the
 * one transformation in the chain whose state cannot grow at all.
 */
export class NewlineCollapser {
	#run = 0;

	constructor(private readonly emit: TextEmit) {}

	async push(piece: string): Promise<void> {
		let out = '';

		for (let index = 0; index < piece.length; index++) {
			if (piece[index] === '\n') {
				this.#run++;
				continue;
			}

			out += this.#collapsed();
			out += piece[index];
		}

		if (out !== '') await this.emit(out);
	}

	async finish(): Promise<void> {
		const tail = this.#collapsed();
		if (tail !== '') await this.emit(tail);
	}

	#collapsed(): string {
		const run = this.#run;
		this.#run = 0;
		return run === 0 ? '' : '\n'.repeat(run < 3 ? run : 2);
	}
}

/**
 * What `escapeLineStart` would do to a line, decided without holding it.
 *
 * The pattern is
 *
 *     /^(\s*)(#{1,6}(?=\s|$)|>|\||[-*+](?=\s)|\d+[.)](?=\s)|`{3,}|~{3,}|-{3,}$|={3,}$)/
 *
 * and its replacement inserts one backslash between the two groups. So all a
 * caller needs is whether it matched and how long the leading whitespace was —
 * the rest of the line is passed through unchanged either way.
 *
 * Two of the alternatives are anchored to the end of the line, which is why
 * this is a scan rather than a peek: a line of nothing but dashes is escaped
 * and a line of dashes followed by anything is not, and telling those apart
 * means reaching the end. Everything it holds while doing so is a counter.
 */
export interface LineStartEscape {
	matched: boolean;
	whitespaceLength: number;
}

export function decideLineStart(pieces: Iterable<string>): LineStartEscape {
	let whitespaceLength = 0;
	let leading = true;

	/** The run of one repeated character that begins the line's content. */
	let head = '';
	let headRun = 0;
	/** Characters that followed that run, up to what any alternative needs. */
	let after = '';
	let digits = 0;

	for (const piece of pieces) {
		for (let index = 0; index < piece.length; index++) {
			const character = piece[index];

			if (leading) {
				if (isWhitespace(piece.charCodeAt(index))) {
					whitespaceLength++;
					continue;
				}
				leading = false;
				head = character;
				headRun = 1;
				if (character >= '0' && character <= '9') digits = 1;
				continue;
			}

			if (after === '' && character === head && !(head >= '0' && head <= '9')) {
				headRun++;
				continue;
			}

			if (after === '' && digits > 0 && character >= '0' && character <= '9') {
				digits++;
				continue;
			}

			// Three characters is more than any alternative looks at beyond its
			// opening run, so the rest of the line cannot change the answer —
			// except for the two end-anchored ones, which need to know that the
			// line did not end, and this already tells them that.
			if (after.length < 3) after += character;
		}
	}

	return { matched: matches(head, headRun, digits, after), whitespaceLength };
}

function matches(head: string, headRun: number, digits: number, after: string): boolean {
	if (head === '') return false;

	const nextIsBreak = after === '' || isWhitespace(after.charCodeAt(0));

	// Alternatives are tried in the pattern's order, but only one can apply to
	// a given opening character, so the order does not change the outcome.
	if (head === '#') return headRun <= 6 && nextIsBreak;
	if (head === '>' || head === '|') return true;
	if (head === '`' || head === '~') return headRun >= 3;

	if (head === '-' || head === '*' || head === '+') {
		// `[-*+](?=\s)` wants exactly one before the whitespace.
		if (headRun === 1 && nextIsBreak && after !== '') return true;
		if (headRun === 1 && after === '') return false;
		// `-{3,}$` wants the line to end with the run.
		return head === '-' && headRun >= 3 && after === '';
	}

	if (head === '=') return headRun >= 3 && after === '';
	if (digits > 0) return (after[0] === '.' || after[0] === ')') && after.length > 1 && isWhitespace(after.charCodeAt(1));

	return false;
}
