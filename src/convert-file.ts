/**
 * The layer the Obsidian plugin supplies for itself: turning the parser's
 * `Section`/`Page` tree into a set of files.
 *
 * Nothing here touches the filesystem. A `Sink` receives paths and bytes, so
 * the CLI can write them out while a test collects them in memory and compares
 * whole trees. Names are reserved through a `NameRegistry` rather than by
 * probing the disk, which keeps a dry run and a real run in agreement.
 */
import { createHash } from 'node:crypto';

import { convertPage, SkipReason } from './onenote-file/convert';
import { OneNoteFormatError } from './onenote-file/errors';
import { Page, Section } from './onenote-file/semantic/content';
import { extensionFromBytes, extensionFromName } from './onenote-file/util';
import { NameRegistry, sanitizeFileName } from './names';
import { listSections, readSections, SectionEntry } from './read-section';
import { CabinetLimits } from './onenote-file/cabinet/cabinet';
import { ReaderOptions } from './onenote-file/onestore/options';

export interface Sink {
	write(path: string, data: Uint8Array): Promise<void>;
}

export interface ConvertOptions {
	/** Folder for a note's assets, relative to the note. Empty writes them beside it. */
	attachmentsDir?: string;
	/** False leaves images and embedded files out entirely. */
	writeAttachments?: boolean;
	/** OneNote keeps deleted pages in the section until the recycle bin is emptied. */
	includeDeleted?: boolean;
	/** False writes subpages beside their parent instead of in a folder named after it. */
	nestSubpages?: boolean;
	frontmatter?: boolean;
	/** Cabinet entry names to convert, for a `.onepkg` holding more than you want. */
	sections?: ReadonlySet<string>;
	/**
	 * Size ceilings for the archive. Raising one admits a larger notebook;
	 * they exist so a malformed or hostile file cannot expand without bound.
	 */
	limits?: CabinetLimits;
	/**
	 * Structural ceilings for a section. These bound work and memory rather than
	 * bytes: the default object limit alone admits around a gigabyte of heap for
	 * one section, so on a small machine it is worth lowering, not raising.
	 */
	readerOptions?: ReaderOptions;
	onProgress?: (event: ProgressEvent) => void;
	/** Returning true abandons the conversion at the next page boundary. */
	isCancelled?: () => boolean;
	/**
	 * Shared across a batch, so several inputs can be converted into one output
	 * folder. Without it each file starts with a clean slate and two notebooks
	 * that both hold a section called "Notes" would write over each other.
	 */
	workspace?: Workspace;
}

/** What a batch of files has already claimed and already written. */
export class Workspace {
	readonly names = new NameRegistry();
	/** Identical bytes appear repeatedly across a notebook; one copy is enough. */
	readonly byContent = new Map<string, { path: string, name: string }>();
}

export interface ProgressEvent {
	kind: 'section' | 'note';
	name: string;
	index: number;
	total: number;
}

export interface SkippedItem {
	page: string;
	item: string;
	reason: SkipReason;
}

export interface FailedItem {
	name: string;
	kind: 'unsupported' | 'protected' | 'malformed' | 'limit' | 'unknown';
	code?: string;
	message: string;
}

export interface ConversionReport {
	input: string;
	notes: string[];
	attachments: string[];
	skipped: SkippedItem[];
	errors: FailedItem[];
	cancelled: boolean;
}

const DEFAULTS = {
	attachmentsDir: 'attachments',
	writeAttachments: true,
	includeDeleted: false,
	nestSubpages: true,
	frontmatter: true,
};

function join(...parts: (string | undefined)[]): string {
	return parts.filter(part => part !== undefined && part !== '').join('/');
}

function describe(error: unknown): FailedItem['kind'] {
	return error instanceof OneNoteFormatError ? error.kind : 'unknown';
}

function failure(name: string, error: unknown): FailedItem {
	return {
		name,
		kind: describe(error),
		code: error instanceof OneNoteFormatError ? error.code : undefined,
		message: error instanceof Error ? error.message : String(error),
	};
}

/**
 * A double-quoted YAML scalar.
 *
 * JSON's string escapes are a subset of YAML's double-quoted ones, so a title
 * holding a colon, a quote or a leading `#` survives without a YAML library.
 */
function scalar(value: string): string {
	return JSON.stringify(value);
}

function frontMatterFor(page: Page, section: string, notebook: string | undefined, groups: string[]): string {
	const lines = [
		'---',
		`title: ${scalar(page.title)}`,
		`source: onenote`,
		`onenote-id: ${scalar(page.id)}`,
		`section: ${scalar(section)}`,
	];

	if (notebook) lines.push(`notebook: ${scalar(notebook)}`);
	if (groups.length > 0) lines.push(`section-group: ${scalar(groups.join('/'))}`);
	if (page.createdUtc) lines.push(`created: ${page.createdUtc.toISOString()}`);
	if (page.lastModifiedUtc) lines.push(`updated: ${page.lastModifiedUtc.toISOString()}`);
	if (page.isConflictPage) lines.push('conflict: true');
	if (page.isDeleted) lines.push('deleted: true');

	lines.push('---', '');
	return lines.join('\n');
}

/** The sections a file holds, without decoding any of them. */
export function inspect(data: Uint8Array, fileName: string, limits?: CabinetLimits): SectionEntry[] {
	return listSections(data, fileName, limits);
}

/**
 * Convert one `.one` or `.onepkg` file into `sink`.
 *
 * Paths handed to the sink are relative and `/`-separated. A section that fails
 * to decode is recorded in `errors` and the remaining sections still convert,
 * because a single bad section in a notebook should not cost you the rest.
 */
export async function convertFile(
	data: Uint8Array,
	fileName: string,
	sink: Sink,
	options: ConvertOptions = {},
): Promise<ConversionReport> {
	const opts = { ...DEFAULTS, ...options };
	const report: ConversionReport = { input: fileName, notes: [], attachments: [], skipped: [], errors: [], cancelled: false };
	const { names, byContent } = opts.workspace ?? new Workspace();

	let entries;
	try {
		entries = readSections(data, fileName, {
			wanted: opts.sections?.size ? opts.sections : undefined,
			limits: opts.limits,
			options: opts.readerOptions,
		});
	}
	catch (error) {
		report.errors.push(failure(fileName, error));
		return report;
	}

	const notebook = entries.length > 1 || entries[0]?.groups.length ? baseName(fileName) : undefined;
	let index = 0;

	for (const entry of entries) {
		if (opts.isCancelled?.()) {
			report.cancelled = true;
			return report;
		}

		opts.onProgress?.({ kind: 'section', name: entry.title, index: ++index, total: entries.length });

		let section: Section;
		try {
			section = entry.read();
		}
		catch (error) {
			report.errors.push(failure(entry.title, error));
			continue;
		}

		// A packaged section keeps the section groups it sat in, as OneNote shows them.
		const groups = entry.groups.map(group => sanitizeFileName(group));
		const parent = join(notebook && sanitizeFileName(notebook), ...groups);
		const sectionName = names.claim(parent, sanitizeFileName(section.name || entry.title));
		const sectionDir = join(parent, sectionName);

		await convertSection(section, sectionDir, {
			opts, sink, names, byContent, report,
			label: section.name || entry.title,
			notebook,
			groups: entry.groups,
		});
	}

	return report;
}

interface SectionContext {
	opts: typeof DEFAULTS & ConvertOptions;
	sink: Sink;
	names: NameRegistry;
	byContent: Map<string, { path: string, name: string }>;
	report: ConversionReport;
	label: string;
	notebook: string | undefined;
	groups: string[];
}

async function convertSection(section: Section, sectionDir: string, ctx: SectionContext): Promise<void> {
	const { opts, sink, names, report } = ctx;

	// A page's folder is only spoken for once one of its subpages arrives, so a
	// page with no children leaves no empty folder behind.
	const levels: string[] = [sectionDir];
	const pages = section.pages.filter(page => opts.includeDeleted || !page.isDeleted);
	let done = 0;

	for (const page of pages) {
		if (opts.isCancelled?.()) {
			report.cancelled = true;
			return;
		}

		const depth = opts.nestSubpages ? Math.min(page.level, levels.length - 1) : 0;
		levels.length = depth + 1;
		const target = levels[depth];

		const title = sanitizeFileName(page.title);
		const noteName = names.claim(target, `${title}.md`);
		const notePath = join(target, noteName);
		const stem = noteName.replace(/\.md$/, '');

		opts.onProgress?.({ kind: 'note', name: stem, index: ++done, total: pages.length });

		try {
			const attachmentsDir = join(target, opts.attachmentsDir);

			const converted = await convertPage(page, {
				noteName: stem,
				isCancelled: opts.isCancelled,
				resolveInternalLink: linked => sanitizeFileName(linked),
				onSkipped: (item, reason) => report.skipped.push({ page: stem, item, reason }),
				saveAttachment: async (bytes, suggested) => {
					if (!opts.writeAttachments) return null;
					return saveAttachment(bytes, suggested, attachmentsDir, opts.attachmentsDir, ctx);
				},
			});

			const front = opts.frontmatter ? frontMatterFor(page, ctx.label, ctx.notebook, ctx.groups) : '';
			const body = converted.markdown.endsWith('\n') ? converted.markdown : `${converted.markdown}\n`;

			await sink.write(notePath, new TextEncoder().encode(front + body));
			report.notes.push(notePath);
		}
		catch (error) {
			report.errors.push(failure(stem, error));
		}

		levels.push(join(target, stem));
	}
}

async function saveAttachment(
	bytes: Uint8Array,
	suggested: string,
	attachmentsDir: string,
	linkPrefix: string,
	ctx: SectionContext,
): Promise<{ path: string, name: string }> {
	// OneNote often stores an image with no name at all; its bytes say what it is.
	if (!extensionFromName(suggested)) {
		const sniffed = extensionFromBytes(bytes);
		if (sniffed) suggested = `${suggested}.${sniffed}`;
	}

	const digest = createHash('sha256').update(bytes).digest('hex');
	const key = `${attachmentsDir}\0${digest}`;
	const existing = ctx.byContent.get(key);
	if (existing) return existing;

	const fileName = ctx.names.claim(attachmentsDir, sanitizeFileName(suggested));
	const path = join(attachmentsDir, fileName);

	await ctx.sink.write(path, bytes);
	ctx.report.attachments.push(path);

	// The link is resolved from the note, which sits one level above the folder.
	const resolved = { path: join(linkPrefix, fileName), name: fileName };
	ctx.byContent.set(key, resolved);
	return resolved;
}

function baseName(fileName: string): string {
	return fileName.replace(/^.*[\\/]/, '').replace(/\.(one|onepkg|onex)$/i, '');
}
