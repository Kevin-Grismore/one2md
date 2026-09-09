/**
 * A bounded run, from file descriptors to a report.
 *
 * This is what `--memory-budget` selects. The eager CLI loop reads a file into
 * a `Uint8Array`, converts it, collects a `ConversionReport` and pushes it onto
 * a list; every one of those four steps holds something proportional to the
 * input or the output. Here the file stays on disk behind a descriptor, the
 * conversion streams, the report stays in the workspace store, and what the
 * loop accumulates is four integers and a path per input.
 *
 * It lives beside the CLI rather than in it because the interesting part is not
 * argument parsing: it is that every resource opened has exactly one owner and
 * is closed on every path out — success, failure, a limit, a signal. That is
 * what `Closers` is for, and keeping it here keeps it readable.
 *
 * ## Scope
 *
 * Loose `.one` sections only, in either encoding. A `.onepkg` is a Cabinet
 * archive and a `.onex` is a compound file; reaching a section inside either
 * means expanding it, and an LZX folder expands as one continuous stream, so
 * there is no bounded way to get at the third section without materializing
 * the first two. Supporting them means a bounded expander, which is a separate
 * piece of work — so they are refused here, clearly and before anything is
 * read, rather than quietly falling back to the eager path and blowing the
 * budget the user asked for.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { ProgressEvent } from '../convert-file';
import { SectionEntry } from '../read-section';
import { OneNoteFormatError } from '../onenote-file/errors';
import { ReaderOptions } from '../onenote-file/onestore/options';
import { FsSink, NullSink } from '../sinks';
import { FileDescriptorByteSource } from '../storage/byte-source';
import { ResidentAccount } from './account';
import { fixedBufferBytes, MemoryBudget, sectionStorageFor, workspaceStorageFor } from './budget';
import { ValueMeter } from './limits';
import { convertSectionStream, StreamConvertOptions } from './convert';
import { ReportGroup, StreamWorkspace } from './workspace';

/** The extensions a bounded run cannot take, and what each one is. */
const ARCHIVES: Record<string, string> = {
	'.onepkg': 'a Cabinet archive of sections',
	'.onex': 'a compound file holding a notebook',
};

/**
 * The two containers, by their opening bytes.
 *
 * Checked as well as the extension, because the extension is a claim and these
 * are not: a `.onepkg` renamed to `.one` is still an archive, and refusing it
 * for the right reason is better than letting the indexer fail on a header it
 * cannot make sense of.
 */
const SIGNATURES: [string, readonly number[]][] = [
	['a Cabinet archive of sections', [0x4d, 0x53, 0x43, 0x46]],
	['a compound file holding a notebook', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
];

export class BoundedScopeError extends Error {
	readonly code = 'ONE2MD_BOUNDED_SCOPE';

	constructor(message: string) {
		super(message);
		this.name = 'BoundedScopeError';
	}
}

/**
 * Whether a path is outside what a bounded run can convert.
 *
 * By extension, deliberately: this is called before the file is opened, so
 * that a `.onepkg` named on the command line is refused without a descriptor,
 * a read or an expansion ever happening. A misnamed archive is caught later by
 * the magic-byte check, which costs four bytes.
 */
export function archiveKind(path: string): string | undefined {
	return ARCHIVES[nodePath.extname(path).toLowerCase()];
}

export function boundedScopeError(path: string, kind = archiveKind(path)): BoundedScopeError {
	return new BoundedScopeError(
		`${nodePath.basename(path)} is ${kind ?? 'not a loose section'}, `
		+ 'and the bounded path converts loose .one sections only. '
		+ 'Convert it without --memory-budget, or extract its sections first and convert those.');
}

/**
 * Everything a run has opened, closed newest first.
 *
 * A bounded run holds a descriptor, two stores per section and a workspace
 * store, and it can leave by six routes: finishing, a conversion failure, a
 * budget rejection, a limit, Ctrl-C, or a `SIGTERM`. Rather than repeat the
 * unwinding at each one, everything registers here and the whole stack is
 * released in one place.
 *
 * Closing is newest first because that is the order the dependencies run in —
 * a store's temporary directory should go before the descriptor whose section
 * it describes — and every close is guarded, because the first failure while
 * unwinding must not strand the rest.
 */
export class Closers {
	readonly #stack: { what: string, close: () => void }[] = [];

	add(what: string, close: () => void): () => void {
		const entry = { what, close };
		this.#stack.push(entry);

		return () => {
			const at = this.#stack.indexOf(entry);
			if (at >= 0) this.#stack.splice(at, 1);
			guard(entry);
		};
	}

	/** Release everything still open. Safe to call more than once. */
	closeAll(): void {
		while (this.#stack.length > 0) guard(this.#stack.pop()!);
	}
}

function guard(entry: { what: string, close: () => void }): void {
	try {
		entry.close();
	}
	catch (error) {
		// A failure here is a leak, not a conversion problem, and swallowing it
		// silently is how a full temporary directory goes unnoticed.
		process.stderr.write(
			`  ! could not release ${entry.what}: ${error instanceof Error ? error.message : String(error)}\n`);
	}
}

export interface BoundedRunOptions {
	/**
	 * The inputs, which may be a walk rather than a list.
	 *
	 * Taken as an iterable so the CLI can hand over its directory walk without
	 * having finished it. Each path is written to the workspace store as it
	 * arrives, so the run holds one at a time and the report can name them all
	 * afterwards without any of them having been kept in the heap.
	 */
	files: Iterable<string>;
	out: string;
	budget: MemoryBudget;
	dryRun: boolean;
	overwrite: boolean;
	readerOptions: ReaderOptions;
	convert: Omit<StreamConvertOptions, 'workspace' | 'storage' | 'readerOptions' | 'onProgress' | 'isCancelled'>;
	/**
	 * Somewhere to collect what the run held, for diagnostics and benchmarks.
	 *
	 * Optional. The workspace store, each section's two stores, the read window
	 * and the value meter register themselves with it, so a caller can read the
	 * high water of everything the budget covers without the run keeping any
	 * per-page state to do it.
	 */
	account?: ResidentAccount;
	onProgress?: (event: ProgressEvent) => void;
	/** Called before each input is opened. */
	onStart?: (file: string) => void;
	/** Called once per input, after it is converted, with its share of the report. */
	onInput?: (group: ReportGroup) => void;
	isCancelled?: () => boolean;
}

export interface BoundedRunResult {
	/**
	 * Still open, because the report is in it.
	 *
	 * Every note path, skipped item and failure lives in this store rather than
	 * in the result, which is the whole point — so reading the report means
	 * reading from here, and closing it is the caller's last act. It is
	 * registered with the `Closers` that was passed in, so a signal arriving
	 * mid-report still releases it.
	 */
	workspace: StreamWorkspace;
	/** How many inputs were converted; the groups themselves are in the store. */
	groupCount: number;
	noteCount: number;
	attachmentCount: number;
	failed: boolean;
	cancelled: boolean;
}

/**
 * Convert every input under one budget, sharing one workspace.
 *
 * The workspace is shared so that two sections of the same name in different
 * inputs land beside each other rather than on top of each other, and so that
 * the same image embedded in two notebooks is written once. That sharing is
 * the reason the report has to be read back by range afterwards: the records
 * of every input are interleaved in one run, in the order they happened.
 *
 * The caller owns `closers` so that a signal handler installed around this can
 * release what is open at the moment the signal arrives.
 */
export async function runBounded(
	options: BoundedRunOptions,
	closers: Closers,
): Promise<BoundedRunResult> {
	// Constructed from options rather than from a store, because a workspace
	// only closes a store it made: handing it one makes it a borrower, and a
	// borrowed store's temporary directory is nobody's to remove.
	const workspace = new StreamWorkspace(undefined, workspaceStorageFor(options.budget));
	closers.add('the workspace store', () => workspace.close());

	if (options.account) {
		options.account.declare(
			fixedBufferBytes(options.budget),
			options.budget.valueReserveBytes,
			options.budget.totalBytes);
		options.account.setMeter(new ValueMeter());
		options.account.addCache(workspace, () => workspace.store.cacheStats.highWaterBytes);
		options.account.addCopies(workspace, () => workspace.store.copyHighWaterBytes);
	}

	for (const file of options.files) {
		if (options.isCancelled?.()) {
			workspace.cancelled = true;
			break;
		}

		workspace.recordInput(file);
		options.onStart?.(file);

		const from = workspace.marks;
		await convertOne(file, options, workspace, closers);

		const group: ReportGroup = {
			input: file,
			from,
			to: workspace.marks,
			cancelled: workspace.cancelled,
		};

		// To the store, not to an array: the report is written from there, so
		// a batch of ten thousand inputs costs one group at a time here too.
		workspace.recordGroup(group);
		options.onInput?.(group);
	}

	const summary = workspace.summary;

	return {
		workspace,
		groupCount: workspace.groupCount,
		noteCount: summary.noteCount,
		attachmentCount: summary.attachmentCount,
		failed: summary.errorCount > 0,
		cancelled: workspace.cancelled,
	};
}

/**
 * One input, converted through a descriptor.
 *
 * The name check comes first and costs nothing, then the descriptor is opened
 * and its opening bytes are read — eight at most — to catch a container
 * wearing a `.one` name. Only then is a section indexed.
 */
async function convertOne(
	file: string,
	options: BoundedRunOptions,
	workspace: StreamWorkspace,
	closers: Closers,
): Promise<void> {
	const name = nodePath.basename(file);

	if (archiveKind(file)) {
		workspace.recordFailure(name, boundedScopeError(file));
		return;
	}

	let fd: number;
	try {
		fd = nodeFs.openSync(file, 'r');
	}
	catch (error) {
		workspace.recordFailure(name, error);
		return;
	}

	const release = closers.add(`the descriptor for ${name}`, () => nodeFs.closeSync(fd));
	let releaseSink = () => {};

	try {
		const source = new FileDescriptorByteSource(fd);
		const container = containerKind(source);

		if (container) {
			workspace.recordFailure(name, boundedScopeError(file, container));
			return;
		}

		const sink = options.dryRun ? new NullSink() : new FsSink(options.out, options.overwrite);

		// Registered so that an exit which does not unwind still deletes the
		// note it was in the middle of. `abortAll` is a no-op once the input
		// has finished, so releasing it below is tidiness rather than need —
		// but leaving a finished sink registered would hold it for the rest of
		// the batch, and the whole point is that nothing lasts longer than the
		// input it belongs to.
		if (sink instanceof FsSink) {
			releaseSink = closers.add(`the open files of ${name}`, () => sink.abortAll());
		}

		await convertSectionStream(source, name, sink, {
			...options.convert,
			readerOptions: options.readerOptions,
			storage: {
				...sectionStorageFor(options.budget),
				account: options.account,
				// So a forced exit removes this section's temporary stores.
				// They are closed by the section either way; this is only for
				// the exit that never reaches the closing.
				onOpen: (what, close) => closers.add(`${what} for ${name}`, close),
			},
			workspace,
			onProgress: options.onProgress,
			isCancelled: options.isCancelled,
		});
	}
	catch (error) {
		// `convertSectionStream` records its own failures; this is for what
		// happens around it — a descriptor that went away, a store that could
		// not be created, a budget a section could not be opened under.
		workspace.recordFailure(name, error);
	}
	finally {
		releaseSink();
		release();
	}
}

/**
 * Which container this is, if it is one, from its opening bytes.
 *
 * Read through the source, so the cost is the longest signature — eight bytes
 * — rather than the file.
 */
function containerKind(source: FileDescriptorByteSource): string | undefined {
	for (const [kind, signature] of SIGNATURES) {
		if (source.size < signature.length) continue;
		const magic = source.read(0, signature.length);
		if (signature.every((byte, index) => magic[index] === byte)) return kind;
	}

	return undefined;
}

/**
 * What a bounded `--list` can say about an input.
 *
 * A loose section is one section named after its file, which the eager
 * `listSections` also returns — it just reads the whole file to decide the
 * input is not an archive, and eight bytes decide that here.
 */
export function listBounded(file: string): SectionEntry {
	if (archiveKind(file)) throw boundedScopeError(file);

	const fd = nodeFs.openSync(file, 'r');
	try {
		const container = containerKind(new FileDescriptorByteSource(fd));
		if (container) throw boundedScopeError(file, container);
	}
	finally {
		nodeFs.closeSync(fd);
	}

	const name = nodePath.basename(file);
	return { name, title: name.replace(/\.one$/i, ''), groups: [] };
}

/** Whether a temporary root can actually be written to, before a store needs it. */
export function checkTempDirectory(path: string): void {
	try {
		nodeFs.mkdirSync(path, { recursive: true });
		nodeFs.accessSync(path, nodeFs.constants.W_OK);
	}
	catch (error) {
		throw new OneNoteFormatError(
			'ONE2MD_TEMP_DIR_LIMIT',
			`The temporary directory ${path} cannot be written to: `
			+ `${error instanceof Error ? error.message : String(error)}`);
	}
}
