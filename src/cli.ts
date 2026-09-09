/**
 * one2md — convert OneNote `.one` and `.onepkg` files to Markdown.
 *
 * Everything happens locally: the file format is decoded here, so there is no
 * Microsoft account, no Graph API and no network access at any point.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { ConversionReport, convertFile, FailedItem, inspect, Workspace } from './convert-file';
import { CabinetLimits, DEFAULT_CABINET_LIMITS } from './onenote-file/cabinet/cabinet';
import { DEFAULT_READER_OPTIONS, ReaderOptions } from './onenote-file/onestore/options';
import { OneNoteFormatError } from './onenote-file/errors';
import { FsSink, NullSink } from './sinks';
import {
	BudgetError,
	DEFAULT_BOUNDED_BUDGET_BYTES,
	MemoryBudget,
	planBudget,
	summarize,
} from './stream/budget';
import { BufferedTextOut, writeJsonReport } from './stream/report-json';
import { archiveKind, boundedScopeError, checkTempDirectory, Closers, listBounded, runBounded } from './stream/run';

const USAGE = `one2md — convert OneNote .one / .onepkg files to Markdown

Usage:
  one2md <input...> [options]

Inputs may be .one or .onepkg files, or folders to search for them.

Options:
  -o, --out <dir>        Where to write (default: ./out)
      --list             List the sections in each input and exit
      --sections <a,b>   Only convert these sections of a .onepkg (by entry name)
      --notebook <name>  Name the notebook these sections came from
      --dry-run          Report what would be written without writing it
      --overwrite        Replace existing files instead of failing on them
      --no-attachments   Leave images and embedded files out
      --attachments <d>  Folder name for assets beside a note (default: attachments)
      --no-frontmatter   Omit the YAML header
      --no-nest          Write subpages beside their parent, not in a folder
      --include-deleted  Include pages still in OneNote's recycle bin
      --json             Emit a machine-readable report on stdout
      --max-entry-bytes <n>     Largest single section, e.g. 512M (default 512M)
      --max-expanded-bytes <n>  Largest expanded archive, e.g. 4G (default 2G)
      --max-entries <n>         Most entries in an archive (default 4096)
      --max-objects <n>         Most objects per section (default 1000000)
      --memory-budget <size>    Convert with a hard ceiling on the converter's
                                own buffers, e.g. 8M. Selects the bounded path,
                                which reads loose .one sections through a file
                                descriptor and never holds one whole. Minimum
                                1M. Excludes the fixed Node runtime overhead.
      --temp-dir <path>         Where the bounded path creates its private
                                temporary directories. Implies the bounded path.
  -q, --quiet            Only report failures
  -h, --help             Show this message

Exit codes:
  0    every input converted
  1    at least one input or section failed
  2    bad usage
  130  cancelled by SIGINT or SIGTERM before finishing
`;

interface Options {
	inputs: string[];
	out: string;
	list: boolean;
	sections?: Set<string>;
	notebook?: string;
	dryRun: boolean;
	overwrite: boolean;
	attachments: boolean;
	attachmentsDir: string;
	frontmatter: boolean;
	nest: boolean;
	includeDeleted: boolean;
	json: boolean;
	quiet: boolean;
	maxEntryBytes?: number;
	maxExpandedBytes?: number;
	maxEntries?: number;
	maxObjects?: number;
	memoryBudget?: number;
	tempDir?: string;
}

class UsageError extends Error {}

/** A byte count, plain or with a K/M/G suffix. */
function parseSize(flag: string, value: string): number {
	const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(value.trim());
	if (!match) throw new UsageError(`${flag} expects a size such as 512M or 4G, not "${value}"`);

	const scale = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[match[2].toLowerCase()]!;
	return Math.floor(Number(match[1]) * scale);
}

function parseCount(flag: string, value: string): number {
	const count = Number(value);
	if (!Number.isInteger(count) || count < 1) throw new UsageError(`${flag} expects a whole number, not "${value}"`);
	return count;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		inputs: [], out: 'out', list: false, dryRun: false, overwrite: false,
		attachments: true, attachmentsDir: 'attachments', frontmatter: true,
		nest: true, includeDeleted: false, json: false, quiet: false,
	};

	const next = (flag: string, value: string | undefined): string => {
		if (value === undefined) throw new UsageError(`${flag} needs a value`);
		return value;
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		switch (arg) {
			case '-o': case '--out': options.out = next(arg, argv[++i]); break;
			case '--list': options.list = true; break;
			case '--sections':
				options.sections = new Set(next(arg, argv[++i]).split(',').map(name => name.trim()).filter(Boolean));
				break;
			case '--notebook': options.notebook = next(arg, argv[++i]); break;
			case '--dry-run': options.dryRun = true; break;
			case '--overwrite': options.overwrite = true; break;
			case '--no-attachments': options.attachments = false; break;
			case '--attachments': options.attachmentsDir = next(arg, argv[++i]); break;
			case '--no-frontmatter': options.frontmatter = false; break;
			case '--no-nest': options.nest = false; break;
			case '--include-deleted': options.includeDeleted = true; break;
			case '--json': options.json = true; break;
			case '--max-entry-bytes': options.maxEntryBytes = parseSize(arg, next(arg, argv[++i])); break;
			case '--max-expanded-bytes': options.maxExpandedBytes = parseSize(arg, next(arg, argv[++i])); break;
			case '--max-entries': options.maxEntries = parseCount(arg, next(arg, argv[++i])); break;
			case '--max-objects': options.maxObjects = parseCount(arg, next(arg, argv[++i])); break;
			case '--memory-budget': options.memoryBudget = parseSize(arg, next(arg, argv[++i])); break;
			case '--temp-dir': options.tempDir = next(arg, argv[++i]); break;
			case '-q': case '--quiet': options.quiet = true; break;
			case '-h': case '--help': process.stdout.write(USAGE); process.exit(0); break;
			default:
				if (arg.startsWith('-')) throw new UsageError(`Unknown option ${arg}`);
				options.inputs.push(arg);
		}
	}

	if (options.inputs.length === 0) throw new UsageError('No input files given');
	return options;
}

const EXTENSIONS = /\.(one|onepkg|onex)$/i;

/** Expand folders into the OneNote files inside them, depth first, in name order. */
function collect(inputs: string[]): string[] {
	return [...discover(inputs)];
}

/**
 * The convertible files under the given paths, one at a time.
 *
 * The eager path collects these into an array, which is right for it: it is
 * about to hold a whole expanded section in memory, so a few thousand paths
 * beside it change nothing. The bounded path cannot, because the thing it
 * promises is that the converter's memory does not grow with the input, and a
 * folder of ten thousand sections is an input.
 *
 * So the walk yields, and it yields in order — the order decides which of two
 * sections of the same name gets the plain file name and which gets the suffix,
 * so an output that depends on `readdir` order is an output that changes
 * between machines. Sorting a directory's entries is the obvious way to get
 * that order and it costs an array of however many entries the directory
 * holds, which for the widest directory someone points this at is the same
 * unbounded thing one level down. `sortedEntries` gets the same order for two
 * strings; see there for what that trades.
 *
 * The recursion holds one path per level of depth, which a filesystem bounds
 * far below anything worth worrying about.
 */
function* discover(inputs: readonly string[]): IterableIterator<string> {
	function* walk(current: string): IterableIterator<string> {
		if (!nodeFs.statSync(current).isDirectory()) {
			yield current;
			return;
		}

		for (const entry of sortedEntries(current)) {
			const full = nodePath.join(current, entry.name);
			if (entry.isDirectory) yield* walk(full);
			else if (EXTENSIONS.test(entry.name)) yield full;
		}
	}

	for (const input of inputs) {
		if (!nodeFs.existsSync(input)) throw new UsageError(`No such file or folder: ${input}`);
		yield* walk(input);
	}
}

/**
 * One directory's names in order, holding one name at a time.
 *
 * `readdirSync` is the obvious way and the wrong one here: it returns every
 * entry at once, which for a directory used as a dumping ground is an array
 * proportional to how much someone put there. Sorting that array is what the
 * ordering needs, and the ordering is not optional — it decides which of two
 * sections with the same name keeps the plain file name and which gets the
 * suffix, so a walk in `readdir` order produces output that differs between
 * machines.
 *
 * So the directory is scanned once per name, each scan keeping only the
 * smallest name greater than the last one yielded. That is a quadratic number
 * of comparisons, which sounds worse than it is: the comparisons are on names
 * already in the operating system's cache, and against the cost of converting
 * even one section they do not register. What it buys is a walk whose memory
 * is two strings regardless of whether the directory holds ten entries or ten
 * million.
 *
 * Ordering follows the previous `readdirSync().sort()`, which compared with
 * `localeCompare`, so no output changes. Whether an entry is a directory is
 * taken from the same `Dirent` the old walk used, so a symbolic link is still
 * not followed.
 */
function* sortedEntries(directory: string): IterableIterator<{ name: string, isDirectory: boolean }> {
	let previous: string | undefined;

	for (;;) {
		let next: { name: string, isDirectory: boolean } | undefined;

		// `opendirSync` hands back entries one at a time rather than all of
		// them, so a scan costs one name however wide the directory is.
		const dir = nodeFs.opendirSync(directory);

		try {
			for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
				if (previous !== undefined && compareNames(entry.name, previous) <= 0) continue;
				if (next === undefined || compareNames(entry.name, next.name) < 0) {
					next = { name: entry.name, isDirectory: entry.isDirectory() };
				}
			}
		}
		finally {
			dir.closeSync();
		}

		if (next === undefined) return;

		previous = next.name;
		yield next;
	}
}

/**
 * A total order over file names.
 *
 * `localeCompare` alone is not one: it answers zero for names a locale treats
 * as the same and a filesystem treats as different, and this walk finds the
 * next name by asking which are greater than the last. Two names comparing
 * equal would mean the second was skipped on every scan and its section never
 * converted — a file silently missing from the output, which is the worst
 * thing a converter can do quietly.
 *
 * So ties fall through to the code units. `sort` left that case unspecified,
 * so pinning it changes no ordering anyone could have relied on.
 */
function compareNames(left: string, right: string): number {
	const byLocale = left.localeCompare(right);
	if (byLocale !== 0) return byLocale;
	return left < right ? -1 : left > right ? 1 : 0;
}

const REASONS: Record<string, string> = {
	unsupported: 'this file uses a OneNote feature the reader does not implement',
	protected: 'the file is rights-protected, so its contents are encrypted',
	malformed: 'the file is damaged or is not a OneNote section',
	limit: 'the file exceeds a safety limit for its size or structure',
	// Overridden per code below; this is the fallback wording.
	unknown: 'unexpected failure',
};

/**
 * What to do about a specific limit.
 *
 * A cap that stops a conversion is only useful if the message says which knob
 * lifts it. These exist because "exceeds a safety limit" told nobody anything.
 */
/**
 * What a cancelled run exits with.
 *
 * 130 is the shell's convention for a process ended by SIGINT — 128 plus the
 * signal number — and it is used for SIGTERM here as well rather than 143.
 * One code for one meaning: the conversion stopped before it finished. A
 * caller distinguishing the two signals has better ways than the exit code,
 * and a caller checking for "did this complete" wants one number to check.
 */
const CANCELLED_EXIT = 130;

const ADVICE: Record<string, string> = {
	ONENOTE_CAB_ENTRY_LIMIT: 'Raise it with --max-entry-bytes, e.g. --max-entry-bytes 2G.',
	ONENOTE_CAB_EXPANDED_LIMIT: 'Raise it with --max-expanded-bytes, e.g. --max-expanded-bytes 6G. '
		+ 'Note that a .onepkg expands whole, so this also needs the memory to hold it.',
	ONENOTE_OBJECT_LIMIT: 'Raise it with --max-objects, or convert fewer sections at a time with --sections.',
	ONENOTE_ASSET_LIMIT: 'A page embeds a file larger than the reader will materialize. '
		+ 'Convert without it using --no-attachments, or raise the reader\'s asset ceiling.',

	// The bounded path's own failures. Each of these can only happen under
	// --memory-budget, and each has a different thing to do about it.
	ONENOTE_VALUE_LIMIT: 'A page holds a title, link, file name or maths run larger than the '
		+ 'memory budget allows to become a string. Raise --memory-budget, which raises the '
		+ 'ceiling with it, or convert this file without --memory-budget.',
	ONENOTE_STRUCTURE_LIMIT: 'A page holds a structure — most likely a very wide table — past '
		+ 'what the bounded path will build. Raise --memory-budget, or convert this file '
		+ 'without it.',
	ONE2MD_BOUNDED_SCOPE: 'The bounded path converts loose .one sections only, because reaching '
		+ 'a section inside an archive means expanding the archive. Convert this input without '
		+ '--memory-budget.',
	ONE2MD_TEMP_DIR_LIMIT: 'Point --temp-dir somewhere writable with room for the temporary '
		+ 'stores, or drop --temp-dir to use the system temporary directory.',
	ENOSPC: 'The disk holding the temporary stores is full. A bounded conversion trades memory '
		+ 'for temporary disk — roughly the size of the section, sometimes more — so point '
		+ '--temp-dir at a filesystem with that much free, or free space where it points now.',
	EDQUOT: 'A disk quota stopped the temporary stores growing. Point --temp-dir at a '
		+ 'filesystem you are not quota-limited on, such as a local scratch disk.',
	EFBIG: 'A temporary store file grew past what the filesystem allows. Point --temp-dir at a '
		+ 'filesystem without that limit, or convert this file without --memory-budget.',
	EROFS: 'The filesystem --temp-dir points at is read-only. Point it somewhere writable, or '
		+ 'drop --temp-dir to use the system temporary directory.',
	PAGED_STORE_SHORT_WRITE: 'The temporary store could not be written. Check for free space '
		+ 'where --temp-dir points, or point it somewhere with more room.',
	PAGED_STORE_TRUNCATED_FILE: 'A temporary store file was truncated while in use. Point '
		+ '--temp-dir at a directory nothing else writes to or cleans up.',
	PAGED_STORE_RECORD_TOO_LARGE: 'A single record outgrew a store page, which a very deeply '
		+ 'nested notebook can do. Convert this file without --memory-budget.',
	BYTE_SOURCE_SHORT_READ: 'The input file ended earlier than its size said. It may have been '
		+ 'modified or truncated while the conversion was reading it.',
	BYTE_WINDOW_TOO_LARGE: 'A structure in this file is larger than the read window the budget '
		+ 'allows. Raise --memory-budget.',
};

const LIMIT_ADVICE = 'Run with --list to see each section and its expanded size, '
	+ 'then convert them in batches with --sections.';

function log(quiet: boolean, line: string): void {
	if (!quiet) process.stderr.write(`${line}\n`);
}

/**
 * Print a report's failures, with whatever advice the code has.
 *
 * Shared by both paths so a bounded failure reads exactly like an eager one,
 * and so the new codes in `ADVICE` reach the bounded path without a second
 * copy of this.
 */
function reportFailures(failures: Iterable<FailedItem>): void {
	for (const error of failures) {
		process.stderr.write(`  ! ${error.name}: ${REASONS[error.kind] ?? error.kind} — ${error.message}\n`);
		const advice = ADVICE[error.code ?? ''];
		if (advice) process.stderr.write(`    ${advice}\n`);
		else if (error.kind === 'limit') process.stderr.write(`    ${LIMIT_ADVICE}\n`);
	}
}

/**
 * The bounded run: descriptors in, chunks out, the report read from a store.
 *
 * The two things worth noticing are that nothing here accumulates per note —
 * the counts come from marks and the paths are read back from the workspace
 * store when the report is written — and that every resource has a registered
 * closer, so a `SIGINT` halfway through a fifty-thousand-page notebook still
 * removes the temporary directories.
 */
async function runBoundedCli(
	files: Iterable<string>,
	options: Options,
	budget: MemoryBudget,
	readerOptions: ReaderOptions,
): Promise<number> {
	const closers = new Closers();

	// A signal asks the conversion to stop rather than killing it: the note in
	// progress is abandoned and deleted, the notes already written stay, the
	// stores close and the temporary files go. A second signal is the user
	// saying they meant it, and Node's default handling takes over.
	//
	// Either way the exit is `CANCELLED_EXIT`, never zero. A run that stopped
	// early did not do what it was asked, and a script that cannot tell the
	// difference will treat a partial conversion as a complete one.
	let cancelled = false;

	// Cancellation is a signal, and a signal cannot be aimed: sending one to a
	// conversion that takes eighty milliseconds either arrives before it starts
	// or after it ends. So the tests ask for it by count instead — stop after
	// this many checks — which puts the interruption in the middle of a note
	// reliably enough to assert on. Read from the environment because the
	// alternative is a flag, and a flag would be a feature.
	const stopAfter = Number(process.env.ONE2MD_TEST_CANCEL_AFTER ?? '');
	let checks = 0;
	const isCancelled = Number.isFinite(stopAfter) && stopAfter > 0
		? () => cancelled || ++checks > stopAfter
		: () => cancelled;

	const onSignal = () => {
		if (cancelled) {
			closers.closeAll();
			process.exit(CANCELLED_EXIT);
		}
		cancelled = true;
		log(options.quiet, 'Cancelling; finishing the current note.');
	};
	const onExit = () => closers.closeAll();

	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);
	process.on('exit', onExit);

	try {
		log(options.quiet, summarize(budget));

		const result = await runBounded({
			files,
			out: options.out,
			budget,
			dryRun: options.dryRun,
			overwrite: options.overwrite,
			readerOptions,
			convert: {
				attachmentsDir: options.attachmentsDir,
				writeAttachments: options.attachments,
				includeDeleted: options.includeDeleted,
				nestSubpages: options.nest,
				frontmatter: options.frontmatter,
				notebookName: options.notebook,
			},
			onStart: file => log(options.quiet, `Reading ${file}`),
			onProgress: event => {
				if (event.kind === 'section') {
					log(options.quiet, `  section ${event.index}/${event.total}: ${event.name}`);
				}
			},
			onInput: group => {
				const notes = group.to.notes - group.from.notes;
				const attachments = group.to.attachments - group.from.attachments;
				const skipped = group.to.skipped - group.from.skipped;
				const errors = group.to.errors - group.from.errors;

				log(options.quiet, `  ${notes} notes, ${attachments} attachments`
					+ (skipped ? `, ${skipped} skipped` : '')
					+ (errors ? `, ${errors} failed` : ''));
			},
			isCancelled,
		}, closers);

		// Whether anything was found is only known once the walk has run, and
		// the walk runs inside the conversion — so the empty case is reported
		// here rather than before it, and reads the same either way.
		if (result.groupCount === 0) {
			throw new UsageError('No .one or .onepkg files found in the given paths');
		}

		// Read after the loop rather than inside it: a failure recorded while
		// converting is printed with its input, but the range is only closed
		// once that input is done. The groups come back out of the store.
		for (const group of result.workspace.groups()) {
			if (group.to.errors > group.from.errors) {
				reportFailures(result.workspace.failures(group.from.errors, group.to.errors));
			}
		}

		if (options.json) {
			// Written in pieces, so a report of a hundred thousand notes is
			// never a hundred thousand notes' worth of string.
			const out = new BufferedTextOut(text => process.stdout.write(text));
			writeJsonReport(out, result.workspace, result.workspace.groups(), {
				// A cancelled run is not ok even when nothing failed: it did
				// not finish, and the notes it did not reach are missing
				// rather than absent.
				ok: !result.failed && !result.cancelled,
				out: options.out,
				dryRun: options.dryRun,
			});
			out.flush();
		}
		else if (!options.quiet) {
			process.stdout.write(
				`${options.dryRun ? 'Would write' : 'Wrote'} ${result.noteCount} notes `
				+ `and ${result.attachmentCount} attachments`
				+ `${options.dryRun ? '' : ` to ${options.out}`}`
				+ `${result.cancelled ? ' before being cancelled' : ''}\n`);
		}

		if (result.cancelled) return CANCELLED_EXIT;
		return result.failed ? 1 : 0;
	}
	finally {
		closers.closeAll();
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		process.off('exit', onExit);
	}
}

async function main(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	const bounded = options.memoryBudget !== undefined || options.tempDir !== undefined;

	// An archive named on the command line is refused here, which is before
	// its path is stat'd, before a descriptor exists and long before anything
	// would be read or expanded.
	if (bounded) {
		for (const input of options.inputs) {
			if (archiveKind(input)) throw new UsageError(boundedScopeError(input).message);
		}
	}

	// The eager path wants the array; the bounded path is handed the walk and
	// spools it into its own store, so the paths never all exist at once.
	const files = bounded ? undefined : collect(options.inputs);

	if (files && files.length === 0) {
		throw new UsageError('No .one or .onepkg files found in the given paths');
	}

	// Only the caps the user actually named are overridden; the rest keep the
	// reader's defaults, which exist to stop a malformed archive expanding without
	// bound.
	const limits: CabinetLimits = {
		...DEFAULT_CABINET_LIMITS,
		...(options.maxEntryBytes !== undefined && { maxEntryBytes: options.maxEntryBytes }),
		...(options.maxExpandedBytes !== undefined && { maxExpandedBytes: options.maxExpandedBytes }),
		...(options.maxEntries !== undefined && { maxEntries: options.maxEntries }),
	};
	const readerOptions: ReaderOptions = {
		...DEFAULT_READER_OPTIONS,
		...(options.maxObjects !== undefined && { maxObjects: options.maxObjects }),
	};

	let budget: MemoryBudget | undefined;
	if (bounded) {
		if (options.tempDir !== undefined) {
			// Checked now, so a directory that cannot be written to is a usage
			// problem rather than a failure per input later on.
			try {
				checkTempDirectory(options.tempDir);
			}
			catch (error) {
				throw new UsageError(
					`${error instanceof Error ? error.message : String(error)}\n`
					+ `${ADVICE.ONE2MD_TEMP_DIR_LIMIT}`);
			}
		}

		try {
			budget = planBudget(options.memoryBudget ?? DEFAULT_BOUNDED_BUDGET_BYTES, options.tempDir);
		}
		catch (error) {
			if (error instanceof BudgetError) throw new UsageError(error.message);
			throw error;
		}
	}

	if (options.list) {
		let failed = false;
		let listed = 0;
		// Written as each input is inspected, so listing a folder of sections
		// costs one entry rather than all of them. The JSON array is opened and
		// closed here for the same reason.
		if (options.json) process.stdout.write('[\n');

		const inputs = files ?? discover(options.inputs);

		for (const file of inputs) {
			const item = (() => {
				try {
					// A bounded listing reads four bytes to rule out an archive;
					// a loose section is one section, named after its file.
					if (bounded) return { file, sections: [listBounded(file)] };

					const data = nodeFs.readFileSync(file);
					return { file, sections: inspect(data, nodePath.basename(file), limits) };
				}
				catch (error) {
					return {
						file, sections: [],
						error: error instanceof Error ? error.message : String(error),
					};
				}
			})();

			if (item.error) failed = true;

			if (options.json) {
				const text = JSON.stringify(item, null, 2)
					.split('\n').map(line => `  ${line}`).join('\n');
				process.stdout.write(`${listed > 0 ? ',\n' : ''}${text}`);
			}
			else {
				process.stdout.write(`${item.file}\n`);
				if (item.error) process.stdout.write(`  ! ${item.error}\n`);
				for (const section of item.sections) {
					const size = section.expandedLength === undefined
						? ''
						: `\t${(section.expandedLength / 1024 / 1024).toFixed(1)} MiB`;
					const folder = section.folderIndex === undefined ? '' : `\tfolder ${section.folderIndex}`;
					process.stdout.write(`  ${[...section.groups, section.title].join(' / ')}\t${section.name}${size}${folder}\n`);
				}
			}

			listed++;
		}

		if (options.json) process.stdout.write(`${listed > 0 ? '\n' : ''}]\n`);
		if (listed === 0) throw new UsageError('No .one or .onepkg files found in the given paths');

		return failed ? 1 : 0;
	}

	if (budget) return runBoundedCli(discover(options.inputs), options, budget, readerOptions);

	const reports: ConversionReport[] = [];
	// One workspace for the whole run, so two notebooks holding a section of the
	// same name land beside each other instead of on top of each other.
	const workspace = new Workspace();

	for (const file of files ?? []) {
		const name = nodePath.basename(file);
		log(options.quiet, `Reading ${file}`);

		let data: Uint8Array;
		try {
			data = nodeFs.readFileSync(file);
		}
		catch (error) {
			reports.push({
				input: file, notes: [], attachments: [], skipped: [], cancelled: false,
				errors: [{ name, kind: 'unknown', message: error instanceof Error ? error.message : String(error) }],
			});
			continue;
		}

		const sink = options.dryRun ? new NullSink() : new FsSink(options.out, options.overwrite);

		const report = await convertFile(data, name, sink, {
			attachmentsDir: options.attachmentsDir,
			writeAttachments: options.attachments,
			includeDeleted: options.includeDeleted,
			nestSubpages: options.nest,
			frontmatter: options.frontmatter,
			sections: options.sections,
			notebookName: options.notebook,
			limits,
			readerOptions,
			workspace,
			onProgress: event => {
				if (event.kind === 'section') log(options.quiet, `  section ${event.index}/${event.total}: ${event.name}`);
			},
		});

		report.input = file;
		reports.push(report);

		log(options.quiet, `  ${report.notes.length} notes, ${report.attachments.length} attachments`
			+ (report.skipped.length ? `, ${report.skipped.length} skipped` : '')
			+ (report.errors.length ? `, ${report.errors.length} failed` : ''));

		reportFailures(report.errors);
	}

	const failed = reports.some(report => report.errors.length > 0);

	if (options.json) {
		process.stdout.write(`${JSON.stringify({ ok: !failed, out: options.out, dryRun: options.dryRun, reports }, null, 2)}\n`);
	}
	else if (!options.quiet) {
		const notes = reports.reduce((sum, report) => sum + report.notes.length, 0);
		const attachments = reports.reduce((sum, report) => sum + report.attachments.length, 0);
		process.stdout.write(`${options.dryRun ? 'Would write' : 'Wrote'} ${notes} notes and ${attachments} attachments`
			+ `${options.dryRun ? '' : ` to ${options.out}`}\n`);
	}

	return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
	code => process.exit(code),
	error => {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n\n${USAGE}`);
			process.exit(2);
		}

		// Advice is looked up by code for anything that carries one, not only
		// for a format error, because a full temporary disk deserves the same
		// treatment as a section over a limit — and the whole point of the
		// codes is that a caller can act on them.
		const advice = ADVICE[(error as { code?: unknown } | undefined)?.code as string ?? ''];

		if (error instanceof OneNoteFormatError || advice) {
			process.stderr.write(`${(error as Error).message}\n`);
			if (advice) process.stderr.write(`  ${advice}\n`);
			process.exit(1);
		}

		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exit(1);
	});
