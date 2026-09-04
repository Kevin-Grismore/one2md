/**
 * one2md — convert OneNote `.one` and `.onepkg` files to Markdown.
 *
 * Everything happens locally: the file format is decoded here, so there is no
 * Microsoft account, no Graph API and no network access at any point.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { ConversionReport, convertFile, inspect, Workspace } from './convert-file';
import { CabinetLimits, DEFAULT_CABINET_LIMITS } from './onenote-file/cabinet/cabinet';
import { DEFAULT_READER_OPTIONS, ReaderOptions } from './onenote-file/onestore/options';
import { OneNoteFormatError } from './onenote-file/errors';
import { FsSink, NullSink } from './sinks';

const USAGE = `one2md — convert OneNote .one / .onepkg files to Markdown

Usage:
  one2md <input...> [options]

Inputs may be .one or .onepkg files, or folders to search for them.

Options:
  -o, --out <dir>        Where to write (default: ./out)
      --list             List the sections in each input and exit
      --sections <a,b>   Only convert these sections of a .onepkg (by entry name)
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
  -q, --quiet            Only report failures
  -h, --help             Show this message

Exit codes:
  0  every input converted
  1  at least one input or section failed
  2  bad usage
`;

interface Options {
	inputs: string[];
	out: string;
	list: boolean;
	sections?: Set<string>;
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
	const found: string[] = [];

	const walk = (current: string) => {
		const stat = nodeFs.statSync(current);

		if (!stat.isDirectory()) {
			found.push(current);
			return;
		}

		for (const entry of nodeFs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = nodePath.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (EXTENSIONS.test(entry.name)) found.push(full);
		}
	};

	for (const input of inputs) {
		if (!nodeFs.existsSync(input)) throw new UsageError(`No such file or folder: ${input}`);
		walk(input);
	}

	return found;
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
const ADVICE: Record<string, string> = {
	ONENOTE_CAB_ENTRY_LIMIT: 'Raise it with --max-entry-bytes, e.g. --max-entry-bytes 2G.',
	ONENOTE_CAB_EXPANDED_LIMIT: 'Raise it with --max-expanded-bytes, e.g. --max-expanded-bytes 6G. '
		+ 'Note that a .onepkg expands whole, so this also needs the memory to hold it.',
	ONENOTE_OBJECT_LIMIT: 'Raise it with --max-objects, or convert fewer sections at a time with --sections.',
	ONENOTE_ASSET_LIMIT: 'A page embeds a file larger than the reader will materialize. '
		+ 'Convert without it using --no-attachments, or raise the reader\'s asset ceiling.',
};

const LIMIT_ADVICE = 'Run with --list to see each section and its expanded size, '
	+ 'then convert them in batches with --sections.';

function log(quiet: boolean, line: string): void {
	if (!quiet) process.stderr.write(`${line}\n`);
}

async function main(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	const files = collect(options.inputs);

	if (files.length === 0) {
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

	if (options.list) {
		const listing = files.map(file => {
			try {
				const data = nodeFs.readFileSync(file);
				return { file, sections: inspect(data, nodePath.basename(file), limits) };
			}
			catch (error) {
				return { file, sections: [], error: error instanceof Error ? error.message : String(error) };
			}
		});

		if (options.json) process.stdout.write(`${JSON.stringify(listing, null, 2)}\n`);
		else {
			for (const item of listing) {
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
		}

		return listing.some(item => item.error) ? 1 : 0;
	}

	const reports: ConversionReport[] = [];
	// One workspace for the whole run, so two notebooks holding a section of the
	// same name land beside each other instead of on top of each other.
	const workspace = new Workspace();

	for (const file of files) {
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

		for (const error of report.errors) {
			process.stderr.write(`  ! ${error.name}: ${REASONS[error.kind] ?? error.kind} — ${error.message}\n`);
			const advice = ADVICE[error.code ?? ''];
			if (advice) process.stderr.write(`    ${advice}\n`);
			else if (error.kind === 'limit') process.stderr.write(`    ${LIMIT_ADVICE}\n`);
		}
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

		if (error instanceof OneNoteFormatError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}

		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exit(1);
	});
