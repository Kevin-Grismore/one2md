/**
 * The places a value still has to become a value.
 *
 * Almost everything in the conversion is streamed, and where something is
 * streamed there is nothing to limit: a note's body, an attachment's bytes and
 * a table's cells all pass through in pieces whose size is set by the reader,
 * not by the file. A few things cannot be, and each of them is here.
 *
 * They fall into two groups. Some are values the output is named after — a
 * page title becomes a file name, a hyperlink target becomes a link — and a
 * name has to exist before it can be used. The others are transformations with
 * no streaming form: `String.normalize('NFKC')` needs the whole string, and a
 * heading's style identifier is compared against a pattern.
 *
 * None of them is large in a file OneNote wrote. All of them are as large as a
 * hostile file says they are, and the point of a memory budget is that it holds
 * whatever the file claims. So each is read against a ceiling, and a value past
 * the ceiling is a reported failure rather than an allocation — the page fails,
 * the conversion continues, and the message says which limit and how to raise
 * it.
 */
import { OneNoteFormatError } from '../onenote-file/errors';

export interface StreamLimits {
	/**
	 * UTF-16 units one metadata value may occupy.
	 *
	 * A page title, a section name, a hyperlink target, an attachment's stored
	 * name, a paragraph style identifier, a note tag's label, a list format, a
	 * recognized word. Every one of them is a short string in practice.
	 */
	maxValueChars: number;
	/**
	 * UTF-16 units one maths run may occupy.
	 *
	 * Its LaTeX form is produced by NFKC normalization and two whole-string
	 * substitutions, none of which has a streaming form, so the run's text is
	 * built before it is converted.
	 */
	maxMathChars: number;
	/**
	 * UTF-16 units of whitespace one text run may open or close with.
	 *
	 * A run's markers sit inside its whitespace, so the whitespace is held
	 * until it is known whether a core follows it. Held on disk past this,
	 * which is why the number is a spill threshold rather than a ceiling.
	 */
	runWhitespaceChars: number;
	/**
	 * Columns one table may have.
	 *
	 * Nothing about a column is held, but every column is a separator cell and
	 * a cell per row, so a file claiming a billion of them is a refusal rather
	 * than an afternoon.
	 */
	maxTableColumns: number;
	/**
	 * Somewhere to record the largest value seen, if anything is watching.
	 *
	 * Diagnostics only, and two numbers — a high-water mark per kind, updated
	 * in place. It exists because the reserve these limits are derived from is
	 * the one part of the budget that is a reservation rather than a measured
	 * cache, and a reservation nobody has ever compared against reality is a
	 * guess. Absent by default, so a normal conversion pays nothing.
	 */
	meter?: ValueMeter;
}

/**
 * The largest value and the largest maths run a conversion materialized.
 *
 * Two integers, not a log: the point is to know whether the reserve is the
 * right size, and for that a maximum is the whole answer. Anything that grew
 * with the number of values would defeat the purpose of the thing it measures.
 */
export class ValueMeter {
	#value = 0;
	#math = 0;

	/** Characters of a metadata value about to be, or just, materialized. */
	value(chars: number): void {
		if (chars > this.#value) this.#value = chars;
	}

	math(chars: number): void {
		if (chars > this.#math) this.#math = chars;
	}

	get peakValueChars(): number {
		return this.#value;
	}

	get peakMathChars(): number {
		return this.#math;
	}

	/**
	 * Bytes the reserve must hold for what was actually seen.
	 *
	 * The same arithmetic `planBudget` reserves by, applied to observation
	 * instead of to a ceiling — so the two can be compared.
	 */
	get reservedBytesUsed(): number {
		return reserveFor(this.#value, this.#math);
	}
}

/** Live copies of one metadata value, at the worst moment. */
export const VALUE_COPIES = 5;

/** Live copies of one maths run, at the worst moment. */
export const MATH_COPIES = 8;

/**
 * Bytes needed to hold values and maths runs of these sizes.
 *
 * Two bytes a UTF-16 unit, times the copies each kind can have alive at once.
 *
 * A metadata value reaches five: the accumulator a title is built in, the
 * string `readString` returns, the copy `trimTrailingNulls` makes of it, the
 * sanitized file name derived from that, and the candidate a name claim tries.
 *
 * A maths run reaches eight, because its conversion is a chain of whole-string
 * transformations and every link's result is reachable until the expression
 * finishes: the accumulated run, its trimmed core, two passes of script-run
 * substitution, NFKC normalization, an invisible-character strip, a trim, and
 * the delimited result. None of them has a streaming form — that is why the
 * run is materialized at all — so the chain is the cost of supporting maths.
 */
export function reserveFor(valueChars: number, mathChars: number): number {
	return 2 * (VALUE_COPIES * valueChars + MATH_COPIES * mathChars);
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = {
	maxValueChars: 1 << 20,
	maxMathChars: 1 << 20,
	runWhitespaceChars: 64 * 1024,
	maxTableColumns: 4096,
};

/**
 * How the reserve is split between the two kinds.
 *
 * Values outnumber maths runs by a wide margin and a title becomes a file
 * name, so they get most of it; a maths run is an equation, and an equation
 * that needs more than the quarter share is not an equation.
 */
const VALUE_SHARE = 0.75;

/**
 * The reserve when nobody has stated one.
 *
 * For a library caller who opens a section without a budget. Generous on
 * purpose: it works out to roughly seventy-eight thousand characters for a
 * value, against the forty-four the largest committed fixture reaches.
 */
export const DEFAULT_VALUE_RESERVE_BYTES = 1024 * 1024;

/**
 * Limits derived from the bytes reserved to hold the values.
 *
 * This takes the reserve rather than the whole budget, and that is the point.
 * A ceiling worked out from some other number — the size of a cache, say — is
 * a ceiling nothing has agreed to pay for: the cache is still the size it was,
 * and the strings are extra. Inverting the reserve arithmetic instead means
 * the largest values the limits will admit are exactly the values the budget
 * already set bytes aside for, so a conversion that stays inside its limits
 * cannot put the budget over.
 */
export function limitsFor(reserveBytes: number, overrides: Partial<StreamLimits> = {}): StreamLimits {
	const valueChars = Math.floor(reserveBytes * VALUE_SHARE / (2 * VALUE_COPIES));
	const mathChars = Math.floor(reserveBytes * (1 - VALUE_SHARE) / (2 * MATH_COPIES));

	return {
		...DEFAULT_STREAM_LIMITS,
		maxValueChars: Math.max(1, valueChars),
		maxMathChars: Math.max(1, mathChars),
		...overrides,
	};
}

/**
 * The failure a value past its ceiling produces.
 *
 * The code ends in `_LIMIT`, which is what makes it a `limit` failure rather
 * than a malformed one — the difference a caller acts on, because a limit is
 * something they can raise and a malformed file is not.
 */
export function overValueLimit(what: string, found: number, limit: number, option: string): OneNoteFormatError {
	return new OneNoteFormatError(
		'ONENOTE_VALUE_LIMIT',
		`${what} is ${found} characters, over the ${limit}-character limit. `
		+ `Raise \`${option}\` to convert it, or convert with a larger memory budget.`);
}

/**
 * Join a part onto a running value, refusing before the join rather than after.
 *
 * The two places that build a value out of many — a page title from its runs,
 * a drawing's recognized text from its strokes — both read each part under
 * `maxValueChars` and both used to check the result afterwards. Neither is
 * enough on its own. A ceiling on the parts says nothing about a title made of
 * a thousand of them, and a check after the join has already allocated the
 * string it is about to reject, which is the allocation the ceiling exists to
 * prevent: at worst the whole limit again, on top of a value already at it.
 *
 * So the arithmetic comes first and the join only happens if it fits. Same
 * error either way, so nothing about the outcome changes — only the peak.
 */
export function joinBounded(
	current: string,
	part: string,
	limit: number,
	what: string,
	meter?: ValueMeter,
): string {
	if (current === '') {
		if (part.length > limit) throw overValueLimit(what, part.length, limit, 'maxValueChars');
		meter?.value(part.length);
		return part;
	}

	const total = current.length + 1 + part.length;
	if (total > limit) throw overValueLimit(what, total, limit, 'maxValueChars');

	meter?.value(total);
	return `${current} ${part}`;
}

/**
 * The exit a cancelled conversion takes.
 *
 * Cancellation is not a failure of the file and not a success either, so it
 * cannot be reported as either. Returning normally was the bug this replaces:
 * a page interrupted half way through was finished, closed, recorded as a
 * note and reported as `ok`, which is the one outcome that must never happen —
 * a truncated note that nothing says is truncated.
 *
 * So it travels as a throw. Every layer already unwinds correctly on a throw:
 * the note's writer is aborted, which deletes the partial file; the page is
 * not recorded; the stores are closed by their `Closers`. What each layer has
 * to add is only telling this apart from a malformed file, which is what the
 * code is for — it is not a `*_LIMIT` and it is not a format error, so nothing
 * that reports per-page failures will report it as one.
 */
export class ConversionCancelled extends Error {
	readonly code = 'ONE2MD_CANCELLED';

	constructor() {
		super('The conversion was cancelled.');
		this.name = 'ConversionCancelled';
	}
}

export function isCancellation(error: unknown): error is ConversionCancelled {
	return error instanceof ConversionCancelled
		|| (error as { code?: unknown } | undefined)?.code === 'ONE2MD_CANCELLED';
}

export function overCountLimit(what: string, found: number, limit: number, option: string): OneNoteFormatError {
	return new OneNoteFormatError(
		'ONENOTE_STRUCTURE_LIMIT',
		`${what} is ${found}, over the limit of ${limit}. Raise \`${option}\` to convert it.`);
}
