/**
 * A file converted a page at a time.
 *
 * This is `convertFile` with the same decisions in the same order — the same
 * notebook and section folders, the same name claiming, the same front matter,
 * the same skip and failure reporting — and none of the same structures. A
 * section is opened rather than read, a page is resolved when it is reached,
 * and a note is written into an open file as it is rendered.
 *
 * The two paths are kept side by side deliberately. `convertFile` is what the
 * Obsidian plugin calls and what the fixtures are checked against; this one has
 * to produce the same bytes, and the way that is checked is by running both.
 */
import { CabinetLimits, DEFAULT_CABINET_LIMITS, readCabinet } from '../onenote-file/cabinet/cabinet';
import { OneNoteFormatError } from '../onenote-file/errors';
import { DEFAULT_READER_OPTIONS, ReaderOptions } from '../onenote-file/onestore/options';
import { isCompoundFile, inspectOnex } from '../onenote-file/onex';
import { sanitizeFileName } from '../names';
import { groupsOf, isPackage } from '../read-section';
import { ProgressEvent, Sink } from '../convert-file';
import { ByteSource, Uint8ArrayByteSource } from '../storage/byte-source';
import { AssetWriter, join } from './assets';
import { PageRenderOptions } from './page';
import { StreamPage, StreamSection, StreamSectionOptions } from './section';
import { asChunkedSink, ChunkedSink } from './sink';
import { isCancellation } from './limits';
import { ReportSummary, StreamWorkspace } from './workspace';

export interface StreamConvertOptions {
	/** Folder for a note's assets, relative to the note. Empty writes them beside it. */
	attachmentsDir?: string;
	writeAttachments?: boolean;
	includeDeleted?: boolean;
	nestSubpages?: boolean;
	frontmatter?: boolean;
	/** Cabinet entry names to convert, for a `.onepkg` holding more than you want. */
	sections?: ReadonlySet<string>;
	notebookName?: string;
	limits?: CabinetLimits;
	readerOptions?: ReaderOptions;
	/** Index and conversion store budgets, which is where the memory ceiling is set. */
	storage?: StreamSectionOptions;
	onProgress?: (event: ProgressEvent) => void;
	isCancelled?: () => boolean;
	/**
	 * Shared across a batch, so several inputs can be converted into one output
	 * folder. Created and closed here when it is not supplied.
	 */
	workspace?: StreamWorkspace;
}

const DEFAULTS = {
	attachmentsDir: 'attachments',
	writeAttachments: true,
	includeDeleted: false,
	nestSubpages: true,
	frontmatter: true,
};

/** One section to convert, and what it is called. */
interface SectionSource {
	source: ByteSource;
	title: string;
	groups: string[];
}

/**
 * Convert a loose `.one` section straight from a byte source.
 *
 * This is the entry point that keeps the promise: a file descriptor goes in,
 * and nothing proportional to the file is ever resident. A `.onepkg` cannot be
 * read this way — see `convertFileStream`.
 */
export async function convertSectionStream(
	source: ByteSource,
	fileName: string,
	sink: Sink,
	options: StreamConvertOptions = {},
): Promise<ReportSummary> {
	return convert([{ source, title: titleOf(fileName), groups: [] }], fileName, sink, options);
}

/**
 * Convert a `.one` or `.onepkg` already in memory.
 *
 * The archive has to be expanded before its sections can be reached, so a
 * package costs its own expanded size here exactly as it does on the eager
 * path. What this changes is everything after that point.
 */
export async function convertFileStream(
	data: Uint8Array,
	fileName: string,
	sink: Sink,
	options: StreamConvertOptions = {},
): Promise<ReportSummary> {
	const workspace = options.workspace ?? new StreamWorkspace();

	let sources: SectionSource[];
	try {
		sources = sectionsOf(data, fileName, options);
	}
	catch (error) {
		workspace.recordFailure(fileName, error);
		const summary = workspace.summary;
		if (!options.workspace) workspace.close();
		return summary;
	}

	return convert(sources, fileName, sink, { ...options, workspace });
}

function sectionsOf(
	data: Uint8Array,
	fileName: string,
	options: StreamConvertOptions,
): SectionSource[] {
	if (isCompoundFile(data)) {
		const kind = inspectOnex(data);
		throw new OneNoteFormatError(
			kind === 'rights-protected' ? 'ONENOTE_ONEX_PROTECTED' : 'ONENOTE_ONEX_UNSUPPORTED',
			kind === 'rights-protected'
				? 'The .onex file is rights-protected and its contents are encrypted.'
				: 'The .onex file is a compound document this importer does not recognise.');
	}

	if (!isPackage(data)) {
		return [{
			source: new Uint8ArrayByteSource(data),
			title: titleOf(fileName),
			groups: [],
		}];
	}

	const wanted = options.sections?.size ? options.sections : undefined;

	return readCabinet(
		data,
		options.limits ?? DEFAULT_CABINET_LIMITS,
		name => /\.one$/i.test(name) && (!wanted || wanted.has(name)),
	).map(entry => ({
		source: new Uint8ArrayByteSource(entry.data),
		title: titleOf(entry.name),
		groups: groupsOf(entry.name),
	}));
}

async function convert(
	sources: SectionSource[],
	fileName: string,
	sink: Sink,
	options: StreamConvertOptions,
): Promise<ReportSummary> {
	const opts = { ...DEFAULTS, ...options };
	const workspace = options.workspace ?? new StreamWorkspace();
	const chunked = asChunkedSink(sink);
	const assets = new AssetWriter(chunked, workspace, { writeAttachments: opts.writeAttachments });

	const notebook = opts.notebookName
		?? (sources.length > 1 || sources[0]?.groups.length ? baseName(fileName) : undefined);

	try {
		let index = 0;

		for (const entry of sources) {
			if (opts.isCancelled?.()) {
				workspace.cancelled = true;
				break;
			}

			opts.onProgress?.({
				kind: 'section',
				name: entry.title,
				index: ++index,
				total: sources.length,
			});

			await convertOne(entry, { opts, workspace, chunked, assets, notebook });
		}

		return workspace.summary;
	}
	finally {
		if (!options.workspace) workspace.close();
	}
}

interface FileContext {
	opts: typeof DEFAULTS & StreamConvertOptions;
	workspace: StreamWorkspace;
	chunked: ChunkedSink;
	assets: AssetWriter;
	notebook: string | undefined;
}

async function convertOne(entry: SectionSource, ctx: FileContext): Promise<void> {
	const { opts, workspace } = ctx;

	let section: StreamSection;
	try {
		section = StreamSection.open(entry.source, ctx.assets, {
			reader: opts.readerOptions ?? DEFAULT_READER_OPTIONS,
			...opts.storage,
		});
	}
	catch (error) {
		if (isCancellation(error)) workspace.cancelled = true;
		else workspace.recordFailure(entry.title, error);
		return;
	}

	try {
		const groups = entry.groups.map(group => sanitizeFileName(group));
		const parent = join(ctx.notebook && sanitizeFileName(ctx.notebook), ...groups);
		const sectionName = workspace.claim(parent, sanitizeFileName(section.name || entry.title));

		await convertPages(section, join(parent, sectionName), entry, ctx);
	}
	catch (error) {
		// A page that fails to render is caught inside `convertPages` and costs
		// that page. What reaches here is a failure of the walk itself — a page
		// whose metadata cannot be read, so the sequence cannot continue — and
		// that costs the section, which is what a section `mapSection` cannot
		// map costs on the eager path.
		if (isCancellation(error)) workspace.cancelled = true;
		else workspace.recordFailure(entry.title, error);
	}
	finally {
		section.close();
		// After closing, a store's cache counters are gone; releasing first
		// keeps the high water this section reached in the running peak.
		opts.storage?.account?.release();
	}
}

/**
 * The pages of one section, in order.
 *
 * The progress events carry a total, and the eager path knows it because it has
 * the array. Here the count is not known until the last page has been reached,
 * so the total grows as the section is walked — a caller driving a progress bar
 * sees it settle rather than start correct.
 */
async function convertPages(
	section: StreamSection,
	sectionDir: string,
	entry: SectionSource,
	ctx: FileContext,
): Promise<void> {
	const { opts, workspace } = ctx;
	const label = section.name || entry.title;

	// A page's folder is only spoken for once one of its subpages arrives, so a
	// page with no children leaves no empty folder behind. The folders live in
	// the workspace's store: a page can be one level deeper than the one before
	// it, so a section that nests all the way down would otherwise carry a path
	// per page.
	const levels = workspace.openSubpageLevels(sectionDir);
	let done = 0;

	for (const page of section.pages()) {
		// Let the event loop turn before each page.
		//
		// Without this a signal is never seen. Every `await` below settles
		// immediately — the sinks write with `writeSync`, the stores read with
		// `readSync` — so the whole conversion is one unbroken run of
		// microtasks. Microtasks drain before the loop advances, and a signal
		// handler is a macrotask, so `SIGINT` sat in the queue until the run
		// had finished and Ctrl-C did nothing at all. `setImmediate` is the
		// cheapest thing that yields to the phase where signals are delivered.
		//
		// Once a page, not once a paragraph: a page takes milliseconds and
		// this takes a fraction of one, so the cost is unmeasurable while the
		// interruption is still prompt.
		await new Promise<void>(resolve => { setImmediate(resolve); });

		if (opts.isCancelled?.()) {
			workspace.cancelled = true;
			return;
		}


		if (page.isDeleted && !opts.includeDeleted) continue;

		const depth = opts.nestSubpages ? Math.min(page.level, levels.depth) : 0;
		levels.truncate(depth);
		const target = levels.at(depth);

		const noteName = workspace.claim(target, `${sanitizeFileName(page.title)}.md`);
		const notePath = join(target, noteName);
		const stem = noteName.replace(/\.md$/, '');

		opts.onProgress?.({ kind: 'note', name: stem, index: ++done, total: done });

		try {
			await writeNote(section, page, notePath, stem, target, label, entry, ctx);
			workspace.recordNote(notePath);
		}
		catch (error) {
			// A cancellation is not this page's fault and not this page's
			// failure. `writeNote` has already aborted the writer, so the
			// partial file is gone; what is left is to not claim the note
			// exists, to not blame it in the errors, and to stop.
			if (isCancellation(error)) {
				workspace.cancelled = true;
				return;
			}

			workspace.recordFailure(stem, error);
		}

		levels.set(depth + 1, join(target, stem));
	}
}

async function writeNote(
	section: StreamSection,
	page: StreamPage,
	notePath: string,
	stem: string,
	target: string,
	label: string,
	entry: SectionSource,
	ctx: FileContext,
): Promise<void> {
	const { opts, workspace } = ctx;

	const writer = await ctx.chunked.open(notePath);
	const note = section.openNote(writer);

	try {
		if (opts.frontmatter) {
			await note.raw(frontMatterFor(page, label, ctx.notebook, entry.groups));
		}

		const render: PageRenderOptions = {
			attachmentsDir: join(target, opts.attachmentsDir),
			linkPrefix: opts.attachmentsDir,
			noteName: stem,
			resolveInternalLink: linked => sanitizeFileName(linked),
			onSkipped: (item, reason) => workspace.recordSkipped(stem, item, reason),
			isCancelled: opts.isCancelled,
		};

		await page.render(note, render);
		await note.finish();
		await writer.close();
	}
	catch (error) {
		await writer.abort?.();
		throw error;
	}
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

function frontMatterFor(
	page: StreamPage,
	section: string,
	notebook: string | undefined,
	groups: string[],
): string {
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

function titleOf(name: string): string {
	return name.replace(/^.*[\\/]/, '').replace(/\.one$/i, '');
}

function baseName(fileName: string): string {
	return fileName.replace(/^.*[\\/]/, '').replace(/\.(one|onepkg|onex)$/i, '');
}
