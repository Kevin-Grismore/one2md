/**
 * one2md — convert OneNote `.one` and `.onepkg` files to Markdown.
 *
 * Everything happens locally: the file format is decoded here, so there is no
 * Microsoft account, no Graph API and no network access at any point.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { ConversionReport, convertFile, inspect, Workspace } from './convert-file';
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
}

class UsageError extends Error {}

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
	unknown: 'unexpected failure',
};

function log(quiet: boolean, line: string): void {
	if (!quiet) process.stderr.write(`${line}\n`);
}

async function main(argv: string[]): Promise<number> {
	const options = parseArgs(argv);
	const files = collect(options.inputs);

	if (files.length === 0) {
		throw new UsageError('No .one or .onepkg files found in the given paths');
	}

	if (options.list) {
		const listing = files.map(file => {
			try {
				const data = new Uint8Array(nodeFs.readFileSync(file));
				return { file, sections: inspect(data, nodePath.basename(file)) };
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
					process.stdout.write(`  ${[...section.groups, section.title].join(' / ')}\t${section.name}\n`);
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
			data = new Uint8Array(nodeFs.readFileSync(file));
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
