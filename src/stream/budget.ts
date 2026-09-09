/**
 * One number, divided among everything that holds bytes.
 *
 * The bounded path has a memory ceiling, but the ceiling is only meaningful if
 * a user can state it as one number and have it mean what it says. Underneath
 * it there are seven separate things with their own sizes — three page caches,
 * a read window, a note buffer, the text spills and the spool chunks — and
 * asking anyone to size those individually is asking them to understand the
 * implementation.
 *
 * So this is the division. It is deliberately explicit rather than clever: the
 * shares are named, the arithmetic is in one place, and `describe` prints what
 * a given budget bought so the division can be checked rather than trusted.
 *
 * ## What the budget covers
 *
 * Every buffer the converter allocates whose size it chooses:
 *
 *   - the workspace store's page cache, which holds claimed names, content
 *     digests and report records for the whole batch;
 *   - the section index's page cache, which holds revision, object and
 *     file-data descriptors for the section being converted;
 *   - the conversion store's page cache, which holds resolved object maps,
 *     property descriptors and the spilled scratch;
 *   - the sliding read window over the section file;
 *   - the buffer between the note writer and the sink;
 *   - the text spills, which hold whitespace and a line before deciding it;
 *   - the spool chunk buffers, one per spool region;
 *   - the record-copy reserve and the value reserve, described below.
 *
 * The first three are caches with a byte budget they enforce themselves; the
 * rest are fixed allocations made once. Only one section is open at a time, so
 * the index cache, the conversion cache and the window are counted once rather
 * than once per input.
 *
 * ## The record-copy reserve
 *
 * `PagedKeyValueStore.get` returns bytes the caller owns rather than a view
 * into the cached page, because the next lookup can evict that page and a view
 * into an evicted page reads whatever replaced it. So every read out of a
 * store is a copy, and a record fits in a page by construction, so every copy
 * is at most a page.
 *
 * Those copies are held by their callers, sometimes several deep — writing the
 * ink SVG walks a stroke record while walking a chunk of points, and the ink
 * decoder holds a chunk of coordinates while the collector writes. So a fixed
 * number of pages is reserved for them, chosen from the deepest nesting the
 * conversion actually reaches rather than from a guess.
 *
 * ## The value reserve
 *
 * A few things cannot be streamed and have to become strings: a page title,
 * because it becomes a file name; a hyperlink target; a maths run, because
 * NFKC normalization has no streaming form. `limits.ts` says which and why.
 *
 * Those strings are as large as the file claims, so they are capped — but a
 * cap is not an accounting. They are still allocations the converter chose to
 * make, in sizes the converter chose, and calling them fixed runtime overhead
 * would be wrong twice over: they are not fixed, and they are not the
 * runtime's. Left out, a budget could be honoured by every cache and still be
 * exceeded by a title.
 *
 * So bytes are reserved for them here, for the worst *simultaneous* set of
 * copies rather than for one of each — a maths run's conversion is a chain of
 * whole-string transformations and every link is reachable until the chain
 * ends. The limits are then derived from that reserve by inverting the same
 * arithmetic, which is what makes the two agree: the largest values the limits
 * admit are the values the reserve already paid for.
 *
 * ## What it does not cover
 *
 * A fixed runtime overhead, excluded because it does not scale with anything
 * the budget is about and cannot be allocated from it:
 *
 *   - Node and V8 themselves — the interpreter, the compiled code, the garbage
 *     collector's own structures. On a current Node this is roughly 30–40 MiB
 *     of resident set before a single byte of OneNote is read, and no option
 *     here changes it.
 *   - The converter's O(1) scratch: a handful of `RecordWriter` key and value
 *     buffers, the text decoders, the descriptor objects for the current page.
 *     Kilobytes, and constant in the size of the input.
 *   - Anything the operating system chooses to cache on the converter's behalf
 *     — the page cache over the temporary store files, most obviously. That is
 *     reclaimable memory the kernel manages, not an allocation.
 *   - Garbage not yet collected. The reserve covers the copies that are live
 *     at once; it does not promise V8 has reclaimed the dead ones by any
 *     particular moment, which is a property of the collector and not of any
 *     option here.
 *
 * So `--memory-budget 8M` means the converter's own buffers and the strings it
 * chooses to build stay inside eight mebibytes. It does not mean the process's
 * resident set is eight mebibytes, and it never could.
 */
import { DEFAULT_WINDOW_BYTES } from '../storage/byte-window';
import { DEFAULT_CHUNK_BYTES } from '../storage/spool';
import { limitsFor, reserveFor, StreamLimits } from './limits';
import { DEFAULT_SPILL_BUDGET } from './text';

/**
 * The store page size, fixed rather than scaled.
 *
 * A record has to fit in a page, and the largest records here hold file paths
 * and property descriptors. Shrinking the page to fit a small budget would
 * trade a memory ceiling for a `PAGED_STORE_RECORD_TOO_LARGE` on a deeply
 * nested notebook, which is a worse failure than asking for more memory.
 */
export const PAGE_BYTES = 64 * 1024;

/**
 * The smallest window that is safe.
 *
 * Reads through the window are checked against its capacity, so a window
 * smaller than the largest fixed-width structure the readers peek at turns
 * into `BYTE_WINDOW_TOO_LARGE` on a valid file. The default is that size, and
 * shrinking below it is not a supported trade.
 */
export const MINIMUM_WINDOW_BYTES = DEFAULT_WINDOW_BYTES;

/** Text spills in one `SpillSet`: trailing, paragraph, line, run whitespace. */
const SPILL_REGIONS = 4;

/**
 * Chunk buffers a section holds at once.
 *
 * Nine spools: four backing the text spills, then ink points, the ink
 * document, recognized text, the title's ink points and one stroke's
 * coordinates. The two record spools are not here — a record spool writes each
 * record straight through and holds no chunk.
 *
 * The tenth is the ink path cursor's, which is not a spool at all but is the
 * same size and is live while a stroke is being decoded. Counted because a
 * budget that names nine of ten buffers is a budget that is wrong by one, and
 * because it was wrong by two before the coordinate spool was added.
 */
const SPOOL_BUFFERS = 10;

/** The buffer between a note writer and its sink. */
const DEFAULT_NOTE_BUFFER_BYTES = 8192;

/**
 * The share of the budget the small fixed buffers may take.
 *
 * They are small at their default sizes and want no more; the fraction only
 * matters at the bottom of the range, where it stops half a megabyte of spills
 * from crowding out the caches that do the work.
 */
const FIXED_BUFFER_SHARE = 0.25;

/** The four large components: three page caches and the read window. */
const LARGE_COMPONENTS = 4;

/**
 * Record copies a caller can be holding at once.
 *
 * The deepest nesting in the conversion, counted rather than estimated:
 * writing an ink drawing holds a stroke record and a chunk of that stroke's
 * points at the same time, and the decoder that filled them holds a chunk of
 * coordinates while the resolver it interleaves with holds a property record.
 * Three, so a fourth would be a change to the conversion rather than to a
 * file — and a change to the conversion should have to change this number.
 */
const RECORD_COPY_PAGES = 3;

/** The share of the budget set aside for values that must be materialized. */
const VALUE_RESERVE_SHARE = 0.125;

/**
 * The smallest reserve, chosen from what real files need.
 *
 * Every committed fixture is measured by `tests/streaming-bounded.test.ts`,
 * and the largest value any of them materializes is forty-four characters — a
 * file name — with the largest maths run at five. This floor buys about seven
 * thousand characters for a value and fifteen hundred for a maths run, so the
 * ceiling sits two orders of magnitude above anything OneNote has been seen to
 * write while still being a number the budget has accounted for.
 */
const MINIMUM_VALUE_RESERVE_BYTES = 96 * 1024;

/**
 * Floors for the small buffers.
 *
 * Below these they stop being buffers: a spill that holds sixteen characters
 * spills on every word, and a chunk smaller than a record is a read per field.
 */
const MINIMUM_SPILL_CHARS = 4096;
const MINIMUM_CHUNK_BYTES = 512;
const MINIMUM_NOTE_BUFFER_BYTES = 1024;

/**
 * The smallest budget that can be divided.
 *
 * Four large components, each of which has a floor — a window may not go below
 * `MINIMUM_WINDOW_BYTES` and a cache may not go below one page — plus the two
 * reserves and the quarter share the small buffers take off the top. Rounded
 * up to something a person would type.
 *
 * It was half this before the record copies were accounted for. They were
 * always being made; a budget that did not name them was simply wrong about
 * its own total, and the honest way to fix that was to raise the floor rather
 * than to keep quiet about a reserve the conversion needs.
 */
export const MINIMUM_BUDGET_BYTES = 1024 * 1024;

/**
 * The budget a bounded run uses when only `--temp-dir` was given.
 *
 * Divided four ways with a quarter off the top it comes to about six mebibytes
 * per cache and window, which is near enough the eight-mebibyte defaults the
 * stores use on their own — so asking for a temporary directory does not
 * silently make the conversion slower than not asking for one.
 */
export const DEFAULT_BOUNDED_BUDGET_BYTES = 32 * 1024 * 1024;

export interface MemoryBudget {
	/** What was asked for. */
	totalBytes: number;
	/** Where each store creates its own private temporary directory. */
	tempDirectory?: string;

	workspaceCacheBytes: number;
	indexCacheBytes: number;
	conversionCacheBytes: number;
	windowBytes: number;
	noteBufferBytes: number;
	/** UTF-16 units one text spill holds before going to disk. */
	spillChars: number;
	chunkBytes: number;
	pageSize: number;
	/** Bytes held for the worst simultaneous set of materialized values. */
	valueReserveBytes: number;
	/** Bytes held for the record copies `store.get` hands to its callers. */
	recordCopyBytes: number;
	/** The ceilings that reserve buys, so the two cannot drift apart. */
	limits: StreamLimits;

	/** What the components above add up to, which is what the ceiling means. */
	accountedBytes: number;
}

export class BudgetError extends Error {
	readonly code = 'ONE2MD_BUDGET_TOO_SMALL';

	constructor(message: string) {
		super(message);
		this.name = 'BudgetError';
	}
}

/**
 * Divide a budget among the components that hold bytes.
 *
 * The small buffers are sized first, because they have defaults worth keeping
 * and floors worth respecting; whatever is left is split evenly between the
 * three caches and the window. Caches are rounded down to whole pages, since a
 * cache that cannot hold a whole extra page will not hold it.
 */
export function planBudget(totalBytes: number, tempDirectory?: string): MemoryBudget {
	if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
		throw new BudgetError(
			`A memory budget must be a positive byte count, not ${totalBytes}.`);
	}

	if (totalBytes < MINIMUM_BUDGET_BYTES) {
		throw new BudgetError(
			`A memory budget of ${format(totalBytes)} is below the ${format(MINIMUM_BUDGET_BYTES)} minimum. `
			+ `Below that there is not enough for a ${format(MINIMUM_WINDOW_BYTES)} read window, `
			+ `three ${format(PAGE_BYTES)} store pages, the write buffers, the `
			+ `${format(RECORD_COPY_PAGES * PAGE_BYTES)} of record copies and the `
			+ `${format(MINIMUM_VALUE_RESERVE_BYTES)} held for page titles and maths runs. `
			+ `Use --memory-budget ${format(MINIMUM_BUDGET_BYTES)} or more.`);
	}

	// The default small buffers, scaled down together if a quarter of the
	// budget will not hold them.
	const wanted = SPILL_REGIONS * DEFAULT_SPILL_BUDGET * 2
		+ SPOOL_BUFFERS * DEFAULT_CHUNK_BYTES
		+ DEFAULT_NOTE_BUFFER_BYTES;
	const allowed = Math.floor(totalBytes * FIXED_BUFFER_SHARE);
	const scale = Math.min(1, allowed / wanted);

	// Rounded down to their own natural units, so that a budget divides into
	// sizes a person can recognize rather than into remainders.
	const spillChars = Math.max(MINIMUM_SPILL_CHARS, floorTo(DEFAULT_SPILL_BUDGET * scale, 1024));
	const chunkBytes = Math.max(MINIMUM_CHUNK_BYTES, floorTo(DEFAULT_CHUNK_BYTES * scale, 256));
	const noteBufferBytes = Math.max(
		MINIMUM_NOTE_BUFFER_BYTES, floorTo(DEFAULT_NOTE_BUFFER_BYTES * scale, 512));

	const recordCopyBytes = RECORD_COPY_PAGES * PAGE_BYTES;

	const fixedBytes = SPILL_REGIONS * spillChars * 2
		+ SPOOL_BUFFERS * chunkBytes
		+ noteBufferBytes
		+ recordCopyBytes;

	// Set aside before the caches, because the values have to be affordable at
	// any budget the planner accepts; the limits then come from this number so
	// that nothing can be admitted that it has not paid for.
	const valueReserveBytes = Math.max(
		MINIMUM_VALUE_RESERVE_BYTES, Math.floor(totalBytes * VALUE_RESERVE_SHARE));
	const limits = limitsFor(valueReserveBytes);

	// The caches take whole pages, since a cache that cannot hold another whole
	// page will not hold it, and the window takes what the rounding left over.
	// Otherwise a small budget loses most of a page three times and ends up
	// using four fifths of what it was given.
	const large = totalBytes - fixedBytes - valueReserveBytes;
	const cacheBytes = floorTo(Math.floor(large / LARGE_COMPONENTS), PAGE_BYTES);
	const windowBytes = floorTo(large - cacheBytes * 3, 4096);

	if (cacheBytes < PAGE_BYTES || windowBytes < MINIMUM_WINDOW_BYTES) {
		// Reachable only if the floors above are raised without raising the
		// minimum with them, but a wrong answer here is a silent overrun.
		throw new BudgetError(
			`A memory budget of ${format(totalBytes)} leaves ${format(Math.floor(large / LARGE_COMPONENTS))} per component, `
			+ `which is under the ${format(Math.max(PAGE_BYTES, MINIMUM_WINDOW_BYTES))} each one needs. `
			+ `Use --memory-budget ${format(MINIMUM_BUDGET_BYTES)} or more.`);
	}

	return {
		totalBytes,
		tempDirectory,
		workspaceCacheBytes: cacheBytes,
		indexCacheBytes: cacheBytes,
		conversionCacheBytes: cacheBytes,
		windowBytes,
		noteBufferBytes,
		spillChars,
		chunkBytes,
		pageSize: PAGE_BYTES,
		valueReserveBytes,
		recordCopyBytes,
		limits,
		accountedBytes: cacheBytes * 3 + windowBytes + fixedBytes + valueReserveBytes,
	};
}

function floorTo(value: number, unit: number): number {
	return Math.floor(value / unit) * unit;
}

/**
 * The budget as the section opener wants it.
 *
 * Both stores a section owns are sized here, along with the window and the
 * buffers, so a caller passes one object and every component inside is
 * accounted for.
 */
export function sectionStorageFor(budget: MemoryBudget): {
	pageSize: number;
	cacheBytes: number;
	conversionCacheBytes: number;
	windowBytes: number;
	spillChars: number;
	chunkBytes: number;
	noteBufferBytes: number;
	limits: Partial<StreamLimits>;
	valueReserveBytes: number;
	tempDirectory?: string;
} {
	return {
		pageSize: budget.pageSize,
		cacheBytes: budget.indexCacheBytes,
		conversionCacheBytes: budget.conversionCacheBytes,
		windowBytes: budget.windowBytes,
		spillChars: budget.spillChars,
		chunkBytes: budget.chunkBytes,
		noteBufferBytes: budget.noteBufferBytes,
		// Passed rather than recomputed, so the ceilings a section enforces are
		// the ones this budget reserved for and not a second derivation of them.
		limits: budget.limits,
		valueReserveBytes: budget.valueReserveBytes,
		tempDirectory: budget.tempDirectory,
	};
}

/** The budget as the batch-wide workspace store wants it. */
export function workspaceStorageFor(budget: MemoryBudget): {
	pageSize: number;
	cacheBytes: number;
	tempDirectory?: string;
} {
	return {
		pageSize: budget.pageSize,
		cacheBytes: budget.workspaceCacheBytes,
		tempDirectory: budget.tempDirectory,
	};
}

/** One line, for a run that wants to say what it is working inside of. */
export function summarize(budget: MemoryBudget): string {
	return `memory budget ${format(budget.totalBytes)}: `
		+ `caches ${format(budget.workspaceCacheBytes)} x3, `
		+ `window ${format(budget.windowBytes)}, `
		+ `values ${format(budget.valueReserveBytes)}, `
		+ `buffers ${format(budget.accountedBytes - budget.workspaceCacheBytes * 3
			- budget.windowBytes - budget.valueReserveBytes)}`;
}

/** Every component, for diagnosing a budget and for tests to assert on. */
export function describe(budget: MemoryBudget): string {
	return [
		`memory budget ${format(budget.totalBytes)}`,
		`  workspace cache   ${format(budget.workspaceCacheBytes)}`,
		`  index cache       ${format(budget.indexCacheBytes)}`,
		`  conversion cache  ${format(budget.conversionCacheBytes)}`,
		`  read window       ${format(budget.windowBytes)}`,
		`  note buffer       ${format(budget.noteBufferBytes)}`,
		`  text spills       ${format(SPILL_REGIONS * budget.spillChars * 2)} (${SPILL_REGIONS} regions)`,
		`  spool chunks      ${format(SPOOL_BUFFERS * budget.chunkBytes)} (${SPOOL_BUFFERS} regions)`,
		`  record copies     ${format(budget.recordCopyBytes)} (${RECORD_COPY_PAGES} pages)`,
		`  value reserve     ${format(budget.valueReserveBytes)} `
			+ `(${budget.limits.maxValueChars} value chars, ${budget.limits.maxMathChars} maths chars)`,
		`  accounted         ${format(budget.accountedBytes)}`,
	].join('\n');
}

/**
 * Buffers this budget allocates once: the spills, the spool chunks, the note.
 *
 * The three caches and the window report their own high water, and the value
 * reserve is a reservation, so this is the remaining term in the total — named
 * here so that the accounting and the plan cannot disagree about it.
 */
export function fixedBufferBytes(budget: MemoryBudget): number {
	return SPILL_REGIONS * budget.spillChars * 2
		+ SPOOL_BUFFERS * budget.chunkBytes
		+ budget.noteBufferBytes
		+ budget.recordCopyBytes;
}

/** Bytes the worst simultaneous set of values would take at these ceilings. */
export function reserveNeededFor(limits: StreamLimits): number {
	return reserveFor(limits.maxValueChars, limits.maxMathChars);
}

function format(bytes: number): string {
	if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}M`;
	if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024}K`;
	return `${bytes}`;
}
