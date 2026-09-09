/**
 * One page, walked and written in the same pass.
 *
 * The existing pipeline is two passes over two structures: `map.ts` turns an
 * object space into a `Page` of nested `Element`s, and `convert.ts` turns that
 * into a string. Both are the size of the page, and the second cannot start
 * until the first has finished.
 *
 * Neither structure is needed. An element is visited once, in document order,
 * and what it contributes to the note depends on the element and on a little
 * state around it — the list level it sits at, whether the block above was a
 * list item, which callout is open. So the two passes are one here: the walk
 * over the object space emits Markdown as it goes, and nothing between the
 * section on disk and the note on disk is proportional to either.
 *
 * The mapping rules are `map.ts`'s, unchanged, and the rendering rules are
 * `convert.ts`'s, unchanged. Where a rule reads a property, it reads a range;
 * where it built a string, it writes pieces. The two files remain the
 * specification for what this produces, and the fixtures are the check that it
 * still produces it.
 *
 * ## What is not streamed
 *
 * Almost nothing. A cell's whitespace collapsing and pipe escaping are a
 * filter rather than a string, a table's separator row is written rather than
 * built, and a run's leading and trailing whitespace go to a spill.
 *
 * What is left is the tags on a paragraph — at most nine — and the values the
 * output is named after or that have no streaming transform: a title, a link
 * target, a file name, a style identifier, the LaTeX of a maths run. Each is
 * read against the ceiling in `limits.ts`, so each is bounded by the memory
 * budget rather than by the file. See that file for why.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { ReaderOptions } from '../onenote-file/onestore/options';
import {
	decodeInkColor,
	InkDimensionId,
	NATIVE_UNITS_PER_HALF_INCH,
} from '../onenote-file/semantic/ink';
import { Jcid, Property } from '../onenote-file/semantic/schema';
import { extensionFromName } from '../onenote-file/util';
import { IndexedGuid, indexedGuidKey, ObjectDescriptor } from '../indexing/section-index';
import { ResolvedSpace, SpaceResolver } from '../resolve/space';
import { PropertySetView } from '../resolve/property-view';
import { RangeReader, utf16Text } from '../resolve/range-reader';
import {
	dataRange,
	findProperty,
	firstReference,
	readBoolean,
	readFloat,
	readString,
	readUInt32Property,
	references,
	textSlice,
	textSource,
	TextSource,
	uint32Values,
} from '../resolve/values';
import { RecordReader, RecordWriter } from '../storage/records';
import { PagedKeyValueStore } from '../storage/paged-key-value-store';
import { AssetWriter, rangeStream, spoolStream } from './assets';
import {
	StrokeCollector,
	decodeInkPath,
	readInkDimensions,
	writeInkSvg,
} from './ink';
import { NoteWriter } from './markdown';
import { SpillSet } from './spills';
import { CarriageReturnFilter, decideLineStart, isWhitespace, TextSpill, Trimmer } from './text';
import {
	ConversionCancelled,
	DEFAULT_STREAM_LIMITS,
	joinBounded,
	overCountLimit,
	overValueLimit,
	StreamLimits,
	ValueMeter,
} from './limits';
import { SkipReason } from '../onenote-file/convert';

/** Converts half-inch ink units to CSS pixels at 96 DPI. */
const PIXELS_PER_INK_UNIT = 48;

const MAX_TAGS_PER_PARAGRAPH = 9;

const INVISIBLE_MATH = /[\u2061-\u2064]/g;

// Preserve scripts before NFKC folds their glyphs to ordinary characters.
const SUPERSCRIPTS = '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ¹²³';
const SUPERSCRIPT_PLAIN = '0123456789+-=()ni123';
const SUBSCRIPTS = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎';
const SUBSCRIPT_PLAIN = '0123456789+-=()';

// NoteTagShape values that represent admonitions. Labels are localized.
const CALLOUT_SHAPES: Record<number, string> = {
	13: 'important',  // Yellow star
	15: 'question',   // Question mark
	17: 'danger',     // High priority (red exclamation mark)
	21: 'tip',        // Light bulb
	111: 'question',  // Question balloon
};

const HIGHLIGHT_MARKERS: { marker: string, inks: number[][] }[] = [
	{ marker: '🔴', inks: [[0xff, 0x00, 0x00], [0xff, 0x69, 0xb4]] },
	{ marker: '🟠', inks: [[0xff, 0xa5, 0x00]] },
	{ marker: '🟡', inks: [[0xff, 0xff, 0x00]] },
	{ marker: '🟢', inks: [[0x00, 0xff, 0x00], [0x00, 0x80, 0x00]] },
	{ marker: '🔵', inks: [[0x00, 0x00, 0xff], [0x00, 0xff, 0xff]] },
	{ marker: '🟣', inks: [[0x80, 0x00, 0x80], [0xff, 0x00, 0xff]] },
];

const StoreTag = {
	recognition: 40,
	recognitionVisited: 41,
} as const;

const EMPTY = new Uint8Array(0);

/**
 * A Markdown hard line break: two spaces, then the newline.
 *
 * Spelled as a concatenation rather than inside a template literal because a
 * template literal holding a newline can be emitted by the bundler as a
 * literal multi-line string, which puts two spaces at the end of a line of
 * *source* and makes `git diff --check` complain about the build output. The
 * eager renderer spells it the same way, for the same reason.
 */
const HARD_BREAK = '  \n';

export interface Tag {
	checkable: boolean;
	completed: boolean;
	label?: string;
	shape?: number;
}

export interface ListInfo {
	level: number;
	ordered: boolean;
	format?: string;
}

/**
 * A property's references, as something to index rather than something to hold.
 *
 * The walk needs children in order and needs to know how many there are, but it
 * never needs them all at once. Reading each on demand keeps a wide level's
 * cost in the store rather than in heap.
 */
interface Children {
	readonly count: number;
	at(index: number): IndexedGuid;
}

const EMPTY_CHILDREN: Children = {
	count: 0,
	at: () => { throw new RangeError('No children to read.'); },
};

/** One identifier, where a list of them is expected. */
function one(id: IndexedGuid): Children {
	return { count: 1, at: () => id };
}

/**
 * `\n| ${new Array(columns).fill('---').join(' | ')} |`, written not built.
 *
 * A table of ten thousand columns would otherwise be an array of ten thousand
 * dashes, the string they join into, and the copy the template makes of it.
 */
export async function writeSeparatorRow(
	columns: number,
	emit: (text: string) => Promise<void>,
): Promise<void> {
	await emit('\n| ');
	for (let column = 0; column < columns; column++) await emit(column === 0 ? '---' : ' | ---');
	await emit(' |');
}

/**
 * Parts of a title, joined as `collectText`'s caller joins them.
 *
 * A part that is only whitespace is dropped; the rest keep their own spacing
 * and are separated by one space. Accumulating rather than collecting is the
 * same thing done without the array.
 *
 * The title becomes a file name, so it has to become a string, and the ceiling
 * is what keeps a page whose title node holds the note's whole body from
 * turning that body into one.
 */
class TextParts {
	value = '';

	constructor(private readonly limit: number, private readonly meter?: ValueMeter) {}

	add(part: string): void {
		if (part.trim() === '') return;
		this.value = joinBounded(this.value, part, this.limit, 'A page title', this.meter);
	}
}

interface RunStyle {
	math?: boolean;
	highlight?: string;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	superscript?: boolean;
	subscript?: boolean;
	hyperlinkUrl?: string;
}

export interface PageRenderOptions {
	attachmentsDir: string;
	linkPrefix: string;
	noteName: string;
	resolveInternalLink?: (pageTitle: string) => string;
	onSkipped?: (item: string, reason: SkipReason) => void;
	isCancelled?: () => boolean;
}

/**
 * The object space of one page, with the two lookups a walk needs.
 *
 * Every method is a store read, so this is a handle rather than a structure.
 */
class Doc {
	constructor(readonly resolver: SpaceResolver, readonly space: ResolvedSpace) {}

	object(id: IndexedGuid): ObjectDescriptor | undefined {
		return this.space.object(id);
	}

	view(object: ObjectDescriptor | undefined): PropertySetView | undefined {
		return object ? this.resolver.propertiesOf(object) : undefined;
	}

	viewOf(id: IndexedGuid): PropertySetView | undefined {
		return this.view(this.object(id));
	}
}

export class PageRenderer {
	readonly #resolver: SpaceResolver;
	readonly #store: PagedKeyValueStore;
	readonly #spills: SpillSet;
	readonly #assets: AssetWriter;
	readonly #options: ReaderOptions;
	readonly #limits: StreamLimits;
	readonly #key = new RecordWriter(64);
	readonly #value = new RecordWriter(128);

	#doc!: Doc;
	#note!: NoteWriter;
	#page!: PageRenderOptions;
	#strokes!: StrokeCollector;
	/** Recognized words already accepted, and the last of them for comparison. */
	#recognizedCount = 0;
	#lastRecognized: string | undefined;
	#recognitionSlot = 0;

	constructor(
		resolver: SpaceResolver,
		store: PagedKeyValueStore,
		spills: SpillSet,
		assets: AssetWriter,
		options: ReaderOptions,
		limits: StreamLimits = DEFAULT_STREAM_LIMITS,
	) {
		this.#resolver = resolver;
		this.#store = store;
		this.#spills = spills;
		this.#assets = assets;
		this.#options = options;
		this.#limits = limits;
	}

	/**
	 * Write one page's body into `note`.
	 *
	 * The order is `convertPage`'s: outlines, then anything attached directly to
	 * the page, then the ink gathered along the way.
	 */
	async render(
		space: ResolvedSpace,
		pageNode: ObjectDescriptor,
		note: NoteWriter,
		page: PageRenderOptions,
	): Promise<void> {
		this.#doc = new Doc(this.#resolver, space);
		this.#note = note;
		this.#page = page;
		this.#strokes = new StrokeCollector(this.#spills.inkPoints, this.#spills.inkStrokes);
		this.#strokes.reset();
		this.#spills.recognized.reset();
		this.#recognizedCount = 0;
		this.#lastRecognized = undefined;
		this.#recognitionSlot = space.slot;

		const view = this.#doc.view(pageNode);
		this.#collectRecognition(view);

		const children = this.#children(view, Property.elementChildNodes);
		for (let index = 0; index < children.count; index++) {
			// Thrown rather than returned: returning here would leave the note
			// looking finished, and a note that stops half way through has to
			// be indistinguishable from one that was never started.
			if (page.isCancelled?.()) throw new ConversionCancelled();
			await this.#element(children.at(index), 0, new Set());
		}

		await this.#writeCollectedInk();
	}

	/**
	 * The text of a page's title nodes, for a page whose cached title is blank.
	 *
	 * `mapPage` reaches this by building the title's elements and reading their
	 * text back out, so what it produces is the runs' own text rather than
	 * their Markdown — no escaping, no emphasis markers, no links. The parts
	 * are joined the way `collectText` joins them, and the last title node in
	 * the page wins, both of which are that function's behaviour rather than a
	 * choice made here.
	 *
	 * A title is a title, so this is one of the few strings built whole.
	 */
	collectTitle(space: ResolvedSpace, pageNode: ObjectDescriptor): string {
		this.#doc = new Doc(this.#resolver, space);
		this.#recognitionSlot = space.slot;
		this.#strokes = new StrokeCollector(this.#spills.titleInkPoints, this.#spills.titleInkStrokes);
		this.#strokes.reset();

		const pageView = this.#doc.view(pageNode);
		this.#collectRecognition(pageView);

		let title = '';

		for (const titleId of references(pageView, Property.structureElementChildNodes)) {
			const titleNode = this.#doc.object(titleId);
			if (titleNode?.jcid !== Jcid.titleNode) continue;

			const parts = new TextParts(this.#limits.maxValueChars, this.#limits.meter);
			const children = this.#children(this.#doc.view(titleNode), Property.elementChildNodes);
			for (let index = 0; index < children.count; index++) {
				this.#textOf(children.at(index), 0, new Set(), parts);
			}

			title = parts.value.trim();
		}

		return title;
	}

	/**
	 * What one element contributes to a title.
	 *
	 * This is `buildElement` and `collectText` fused: the same dispatch, but
	 * only the branches that produce text, and no element in between. A run is
	 * one part, as it is there — two adjacent runs are separated by a space in
	 * a title even though they are adjacent in the paragraph.
	 */
	#textOf(id: IndexedGuid, depth: number, path: Set<string>, into: TextParts): void {
		const key = indexedGuidKey(id);
		if (depth >= this.#options.maxPropertySetDepth || path.has(key)) return;
		path.add(key);

		try {
			const object = this.#doc.object(id);
			if (!object) return;

			const view = this.#doc.view(object);

			switch (object.jcid) {
				case Jcid.outlineNode:
				case Jcid.outlineGroup:
					this.#eachChild(view, Property.elementChildNodes, depth, path, into);
					return;

				case Jcid.outlineElementNode: {
					const content = this.#children(view, Property.contentChildNodes);
					for (let index = 0; index < content.count; index++) {
						const contentId = content.at(index);
						const candidate = this.#doc.object(contentId);
						if (!candidate) continue;

						if (candidate.jcid === Jcid.inkContainer) {
							if (this.#inkText(candidate, into) !== undefined) break;
							continue;
						}

						if (HANDLED.has(candidate.jcid)) {
							this.#textOf(contentId, depth + 1, path, into);
							break;
						}
					}

					this.#eachChild(view, Property.elementChildNodes, depth, path, into);
					return;
				}

				case Jcid.richTextNode: {
					const source = view && textSource(view, Property.richEditTextUnicode, Property.textExtendedAscii);
					if (!view || !source) return;

					const boundaries = uint32Values(view, Property.textRunIndex);
					const runCount = Math.max(1, boundaries.count + 1);
					let start = 0;

					for (let index = 0; index < runCount; index++) {
						let end = index < boundaries.count
							? Math.min(source.length, boundaries.at(index))
							: source.length;
						if (end < start) end = start;

						this.#limits.meter?.value(end - start);
						if (end - start > this.#limits.maxValueChars) {
							throw overValueLimit(
								'A title\'s text run', end - start, this.#limits.maxValueChars, 'maxValueChars');
						}

						const field = this.#findHyperlinkField(view, source, start, end);
						let run = '';
						for (const piece of this.#runPieces(view, source, start, end, field)) run += piece;
						into.add(run);

						start = end;
					}
					return;
				}

				case Jcid.tableNode:
					for (const rowId of this.#ofKind(
						this.#children(view, Property.elementChildNodes), Jcid.tableRowNode)) {
						for (const cellId of this.#cellsOf(rowId)) {
							this.#eachChild(
								this.#doc.viewOf(cellId), Property.elementChildNodes, depth, path, into);
						}
					}
					return;

				case Jcid.inkContainer:
					this.#inkText(object, into);
					return;

				default:
					return;
			}
		}
		finally {
			path.delete(key);
		}
	}

	#eachChild(
		view: PropertySetView | undefined,
		propertyId: number,
		depth: number,
		path: Set<string>,
		into: TextParts,
	): void {
		const children = this.#children(view, propertyId);
		for (let index = 0; index < children.count; index++) {
			this.#textOf(children.at(index), depth + 1, path, into);
		}
	}

	/** An ink container's recognized words, with its strokes thrown away. */
	#inkText(object: ObjectDescriptor, into: TextParts): string | undefined {
		const words = this.#inkInto(object, this.#strokes);
		if (words) into.add(words);
		return words;
	}

	// -- Walking ------------------------------------------------------------

	/**
	 * The identifiers a property names, addressed rather than listed.
	 *
	 * A level's children are read by position, so walking a page with a hundred
	 * thousand top-level elements never puts a hundred thousand identifiers in
	 * heap — the walk holds an index, and each step reads four bytes.
	 */
	#children(view: PropertySetView | undefined, propertyId: number): Children {
		const property = view?.find(propertyId);
		if (!view || !property?.referenceCount) return EMPTY_CHILDREN;

		return {
			count: property.referenceCount,
			at: index => view.referenceAt(property, index)!,
		};
	}

	async #element(id: IndexedGuid, depth: number, path: Set<string>): Promise<boolean> {
		const key = indexedGuidKey(id);
		if (depth >= this.#options.maxPropertySetDepth || path.has(key)) return false;
		path.add(key);

		try {
			const object = this.#doc.object(id);
			if (!object) return false;

			switch (object.jcid) {
				case Jcid.outlineNode:
				case Jcid.outlineGroup: {
					const children = this.#children(this.#doc.view(object), Property.elementChildNodes);
					for (let index = 0; index < children.count; index++) {
						await this.#element(children.at(index), depth + 1, path);
					}
					return true;
				}

				case Jcid.outlineElementNode:
					await this.#outlineElement(object, depth, path);
					return true;

				case Jcid.richTextNode:
					await this.#paragraph(object, undefined, undefined, depth, path);
					return true;

				case Jcid.imageNode:
					await this.#image(object);
					return true;

				case Jcid.embeddedFileNode:
					await this.#embeddedFile(object);
					return true;

				case Jcid.tableNode:
					await this.#table(object, depth, path);
					return true;

				case Jcid.inkContainer:
					return this.#ink(object);

				default:
					return false;
			}
		}
		finally {
			path.delete(key);
		}
	}

	/**
	 * An outline element: a list level and tags wrapped around one child.
	 *
	 * `buildOutlineElement` folds those into the child when it is a paragraph
	 * and leaves them off when it is not, so which child is the primary one has
	 * to be settled before anything is written. Settling it costs a type
	 * lookup per candidate, except for ink — whose emptiness is only knowable
	 * by decoding it, and which is collected rather than written, so trying it
	 * is harmless.
	 */
	async #outlineElement(object: ObjectDescriptor, depth: number, path: Set<string>): Promise<void> {
		const view = this.#doc.view(object);
		const list = this.#listInfo(view);
		const tags = this.#tags(view);
		const children = this.#children(view, Property.elementChildNodes);
		const content = this.#children(view, Property.contentChildNodes);

		let primary: IndexedGuid | undefined;
		let primaryIsParagraph = false;
		let primaryIsInk = false;

		for (let index = 0; index < content.count; index++) {
			const contentId = content.at(index);
			const candidate = this.#doc.object(contentId);
			if (!candidate) continue;

			if (candidate.jcid === Jcid.richTextNode) {
				primary = contentId;
				primaryIsParagraph = true;
				break;
			}

			if (candidate.jcid === Jcid.inkContainer) {
				// Gathered here rather than inspected, because an ink container
				// with no usable strokes is not an element at all — and
				// gathering is the only way to find out.
				if (await this.#element(contentId, depth + 1, path)) {
					primary = contentId;
					primaryIsInk = true;
					break;
				}
				continue;
			}

			if (HANDLED.has(candidate.jcid)) {
				primary = contentId;
				break;
			}
		}

		if (primary && primaryIsParagraph) {
			await this.#paragraph(this.#doc.object(primary)!, list, tags, depth, path, children);
			return;
		}

		// The primary is written before the element's own children, and an ink
		// one has already been dealt with above.
		if (primary && !primaryIsInk) await this.#element(primary, depth + 1, path);

		for (let index = 0; index < children.count; index++) {
			await this.#element(children.at(index), depth + 1, path);
		}
	}

	// -- Paragraphs ---------------------------------------------------------

	/**
	 * Render one rich-text node as a block, then whatever hangs off it.
	 *
	 * The block is opened by the first character that survives trimming, so a
	 * paragraph whose runs are all whitespace contributes nothing — which is
	 * what `if (text !== '')` does in the string version, without needing the
	 * text to exist first.
	 */
	async #paragraph(
		object: ObjectDescriptor,
		list: ListInfo | undefined,
		inherited: Tag[] | undefined,
		depth: number,
		path: Set<string>,
		extra: Children = EMPTY_CHILDREN,
	): Promise<void> {
		const view = this.#doc.view(object);
		const tags = this.#tags(view) ?? inherited;

		const task = taskPrefix(tags, list);
		const prefix = task ?? listPrefix(list) ?? '';
		const indent = '\t'.repeat(list?.level ?? 0);
		const heading = headingPrefix(this.#styleId(view));
		const callout = calloutFor(tags);
		const asCallout = callout !== undefined && !list && task === undefined;

		const body = new BlockBody(
			this.#note,
			this.#spills,
			prefix || heading,
			indent,
			asCallout
				? () => this.#note.beginCallout(`> [!${callout!.type}]${callout!.title ? ` ${callout!.title}` : ''}`)
				: () => this.#note.beginBlock(task !== undefined || list !== undefined),
		);

		await this.#runs(view, body);
		await body.finish();

		// A rich-text node's own child references are not followed: the children
		// a paragraph has are the ones its outline element handed down. That is
		// `buildParagraph`, which starts them empty, and `buildOutlineElement`,
		// which is the only thing that fills them.
		for (let index = 0; index < extra.count; index++) {
			await this.#element(extra.at(index), depth + 1, path);
		}
	}

	/**
	 * The text runs of a rich-text node, rendered into `into`.
	 *
	 * A run is a slice of one text property, addressed by boundaries stored
	 * beside it — so a run is re-readable from the section as often as it needs
	 * to be, and none of them are held.
	 */
	async #runs(view: PropertySetView | undefined, into: RunTarget): Promise<void> {
		if (!view) return;

		const source = textSource(view, Property.richEditTextUnicode, Property.textExtendedAscii);
		const boundaries = uint32Values(view, Property.textRunIndex);
		const styles = this.#children(view, Property.textRunFormatting);
		const length = source?.length ?? 0;
		const runCount = Math.max(1, boundaries.count + 1);

		/** A HYPERLINK field lifts its target onto the next run that has text. */
		let pending: string | undefined;
		let start = 0;

		for (let index = 0; index < runCount; index++) {
			let end = index < boundaries.count ? Math.min(length, boundaries.at(index)) : length;
			if (end < start) end = start;

			const style: RunStyle = {};
			if (index < styles.count) this.#applyStyle(style, styles.at(index));

			const field = source ? this.#findHyperlinkField(view, source, start, end) : undefined;
			if (field) pending = field.url;

			const remaining = (end - start) - (field ? field.length : 0);
			if (pending !== undefined && remaining > 0) {
				style.hyperlinkUrl ??= pending;
				pending = undefined;
			}

			if (source && remaining > 0) await this.#run(view, source, start, end, field, style, into);

			start = end;
		}
	}

	/**
	 * One run, as `renderRun` renders it.
	 *
	 * The leading and trailing whitespace sit outside whatever markers the
	 * style adds, so both are held back until it is known whether anything
	 * comes after them. A maths run is the exception: its LaTeX form is a
	 * whole-string transform, so its core is built before it is written.
	 */
	async #run(
		view: PropertySetView,
		source: TextSource,
		start: number,
		end: number,
		field: HyperlinkField | undefined,
		style: RunStyle,
		into: RunTarget,
	): Promise<void> {
		const core = new CoreWriter(
			style, this.#page.resolveInternalLink, into, this.#spills.runWhitespace);

		if (style.math) {
			// NFKC normalization has no streaming form, so a maths run is read
			// whole or not at all. The length is known before anything is
			// decoded, which is what makes the refusal free.
			if (end - start > this.#limits.maxMathChars) {
				throw overValueLimit(
					'A maths run', end - start, this.#limits.maxMathChars, 'maxMathChars');
			}
			this.#limits.meter?.math(end - start);

			let text = '';
			for (const piece of this.#runPieces(view, source, start, end, field)) text += piece;
			await core.whole(text);
			return;
		}

		for (const piece of this.#runPieces(view, source, start, end, field)) await core.push(piece);
		await core.finish();
	}

	/** A run's text, with any HYPERLINK field removed, in pieces. */
	*#runPieces(
		view: PropertySetView,
		source: TextSource,
		start: number,
		end: number,
		field: HyperlinkField | undefined,
	): IterableIterator<string> {
		if (!field) {
			yield* textSlice(view, source, start, end);
			return;
		}

		if (field.start > start) yield* textSlice(view, source, start, field.start);
		if (field.start + field.length < end) yield* textSlice(view, source, field.start + field.length, end);
	}

	/**
	 * Find `﷟ HYPERLINK "…"` inside a run, without reading it into a string.
	 *
	 * The pattern begins with a character that appears nowhere else, and every
	 * quantifier in it is followed by something that whitespace cannot be — so
	 * a left-to-right scan that never backtracks accepts exactly what the
	 * regular expression accepts.
	 */
	#findHyperlinkField(
		view: PropertySetView,
		source: TextSource,
		start: number,
		end: number,
	): HyperlinkField | undefined {
		let candidate = -1;
		let position = start;
		let state: 'idle' | 'space' | 'word' | 'gap' | 'url' | 'tail' = 'idle';
		let matched = 0;
		let url = '';

		const restart = () => {
			state = 'idle';
			matched = 0;
			url = '';
			candidate = -1;
		};

		for (const piece of textSlice(view, source, start, end)) {
			for (let index = 0; index < piece.length; index++, position++) {
				const character = piece[index];
				const white = /\s/.test(character);

				if (state === 'idle') {
					if (character === '\ufddf') {
						candidate = position;
						state = 'space';
					}
					continue;
				}

				if (state === 'space') {
					if (white) continue;
					if (character === HYPERLINK_WORD[0]) {
						state = 'word';
						matched = 1;
						if (HYPERLINK_WORD.length === 1) state = 'gap';
						continue;
					}
					restart();
					if (character === '\ufddf') {
						candidate = position;
						state = 'space';
					}
					continue;
				}

				if (state === 'word') {
					if (character === HYPERLINK_WORD[matched]) {
						matched++;
						if (matched === HYPERLINK_WORD.length) state = 'gap';
						continue;
					}
					restart();
					if (character === '\ufddf') {
						candidate = position;
						state = 'space';
					}
					continue;
				}

				if (state === 'gap') {
					// `\s+` needs at least one, and is followed by a quote.
					if (white) {
						matched = -1;
						continue;
					}
					if (character === '"' && matched === -1) {
						state = 'url';
						continue;
					}
					restart();
					if (character === '\ufddf') {
						candidate = position;
						state = 'space';
					}
					continue;
				}

				if (state === 'url') {
					if (character !== '"') {
						// The target becomes a link, so it becomes a string.
						if (url.length >= this.#limits.maxValueChars) {
							throw overValueLimit(
								'A hyperlink field\'s target', url.length + 1,
								this.#limits.maxValueChars, 'maxValueChars');
						}
						url += character;
						continue;
					}
					state = 'tail';
					continue;
				}

				// `\s*` at the end takes every space it can, and the match ends
				// at the first character that is not one.
				if (!white) {
					this.#limits.meter?.value(url.length);
					return { start: candidate, length: position - candidate, url };
				}
			}
		}

		return state === 'tail' ? { start: candidate, length: position - candidate, url } : undefined;
	}

	#applyStyle(style: RunStyle, id: IndexedGuid): void {
		const view = this.#doc.viewOf(id);
		if (!view) return;

		if (readBoolean(view, Property.mathFormatting)) style.math = true;
		const highlight = highlightColor(readUInt32Property(view, Property.highlight));
		if (highlight) style.highlight = highlight;
		if (readBoolean(view, Property.bold)) style.bold = true;
		if (readBoolean(view, Property.italic)) style.italic = true;
		if (readBoolean(view, Property.underline)) style.underline = true;
		if (readBoolean(view, Property.strikethrough)) style.strikethrough = true;
		if (readBoolean(view, Property.superscript)) style.superscript = true;
		if (readBoolean(view, Property.subscript)) style.subscript = true;

		if (readBoolean(view, Property.hyperlink)) {
			const url = readString(view, Property.hyperlinkUrl, this.#limits.maxValueChars, 'A hyperlink target', this.#limits.meter);
			if (url) style.hyperlinkUrl = url;
		}
	}

	#styleId(view: PropertySetView | undefined): string | undefined {
		// The first style object decides, whether or not it names a style: the
		// mapper breaks on finding one rather than on finding a name.
		for (const styleId of references(view, Property.paragraphStyle)) {
			const style = this.#doc.object(styleId);
			if (!style) continue;
			return readString(
				this.#doc.view(style), Property.paragraphStyleId,
				this.#limits.maxValueChars, 'A paragraph style identifier', this.#limits.meter);
		}
		return undefined;
	}

	// -- Tags and lists -----------------------------------------------------

	/** Maps tags by shape because labels are localized. */
	#tags(view: PropertySetView | undefined): Tag[] | undefined {
		if (!view) return undefined;

		const states = findProperty(view, Property.noteTagStates);
		if (!states?.childCount) return undefined;

		const tags: Tag[] = [];
		const limit = Math.min(states.childCount, MAX_TAGS_PER_PARAGRAPH);

		for (let position = 0; position < limit; position++) {
			const state = view.childAt(states, position);
			const status = findProperty(state, Property.actionItemStatus)?.scalarValue ?? 0;
			if ((status & 0x10) !== 0) continue;

			const definitionId = firstReference(state, Property.noteTagDefinitionOid);
			const definition = definitionId ? this.#doc.object(definitionId) : undefined;
			const definitionView = this.#doc.view(definition);

			const shape = findProperty(state, Property.noteTagShape)?.scalarValue
				?? (definition?.jcid === Jcid.noteTagSharedDefinition
					? readUInt32Property(definitionView, Property.noteTagShape)
					: undefined);

			const checkable = shape !== undefined && isCheckableShape(shape);

			tags.push({
				checkable,
				completed: (status & 0x01) !== 0,
				label: checkable ? undefined : readString(
					definitionView, Property.noteTagLabel,
					this.#limits.maxValueChars, 'A note tag label', this.#limits.meter),
				shape,
			});
		}

		return tags.length > 0 ? tags : undefined;
	}

	#listInfo(view: PropertySetView | undefined): ListInfo | undefined {
		let listView: PropertySetView | undefined;

		for (const listId of references(view, Property.listNodes)) {
			const candidate = this.#doc.object(listId);
			if (candidate?.jcid === Jcid.numberListNode) listView = this.#doc.view(candidate);
		}
		if (!listView) return undefined;

		const format = this.#numberListFormat(listView);

		// Ordered-list formats contain a number placeholder.
		return {
			level: Math.max(0, (readUInt32Property(view, Property.outlineElementChildLevel) ?? 1) - 1),
			ordered: format.indexOf('\ufffd') >= 0,
			format: format === '' ? undefined : format,
		};
	}

	/**
	 * A numbered list's format string.
	 *
	 * The value's first unit says how many units after it belong to the format,
	 * and that unit is a `charCodeAt`, so the answer can never be longer than
	 * 65,535 characters however large the property claims to be. Only that much
	 * of it is decoded — plus the unit after, because a surrogate pair is only
	 * a pair when its other half is in the same decode, and cutting the value
	 * short would turn a character into a replacement the whole-value read
	 * never produced.
	 */
	#numberListFormat(view: PropertySetView): string {
		const range = dataRange(view, Property.numberListFormat);
		if (!range || range.length < 2) return '';

		const units = range.length >>> 1;

		let value = '';
		for (const piece of utf16Text(view.window, range, 0, Math.min(units, 0x10002))) value += piece;
		if (value.length === 0) return '';

		return value.slice(1, 1 + Math.min(value.charCodeAt(0), units - 1));
	}

	// -- Tables -------------------------------------------------------------

	/**
	 * A table, written a row at a time.
	 *
	 * GFM needs the column count before the separator row, and the count is the
	 * widest row — so the rows are counted first and rendered second. Counting
	 * reads identifiers only; nothing in a cell is touched until the pass that
	 * writes it, which is what keeps an image inside a cell from being saved
	 * twice.
	 */
	async #table(object: ObjectDescriptor, depth: number, path: Set<string>): Promise<void> {
		const view = this.#doc.view(object);
		const rows = this.#children(view, Property.elementChildNodes);

		let rowCount = 0;
		let columns = 0;
		for (const rowId of this.#ofKind(rows, Jcid.tableRowNode)) {
			rowCount++;
			let cells = 0;
			for (const _ of this.#cellsOf(rowId)) cells++;
			if (cells > columns) columns = cells;
		}
		if (rowCount === 0) return;

		if (columns > this.#limits.maxTableColumns) {
			throw overCountLimit(
				'A table\'s column count', columns, this.#limits.maxTableColumns, 'maxTableColumns');
		}

		await this.#note.beginBlock(false);

		let index = 0;
		for (const rowId of this.#ofKind(rows, Jcid.tableRowNode)) {
			if (index === 1) await this.#separatorRow(columns);
			if (index > 0) await this.#note.push('\n');

			const cells = this.#cellsOf(rowId);
			await this.#note.push('| ');

			for (let column = 0; column < columns; column++) {
				if (column > 0) await this.#note.push(' | ');
				await this.#cell(cells.next().value, depth, path);
			}

			await this.#note.push(' |');
			index++;
		}

		// A one-row table still needs the separator that makes it a table.
		if (rowCount === 1) await this.#separatorRow(columns);
	}

	async #separatorRow(columns: number): Promise<void> {
		await writeSeparatorRow(columns, text => this.#note.push(text));
	}

	/** The children of one kind, in order, holding an index rather than a list. */
	*#ofKind(children: Children, jcid: number): IterableIterator<IndexedGuid> {
		for (let index = 0; index < children.count; index++) {
			const id = children.at(index);
			if (this.#doc.object(id)?.jcid === jcid) yield id;
		}
	}

	#cellsOf(rowId: IndexedGuid): IterableIterator<IndexedGuid> {
		const children = this.#children(this.#doc.viewOf(rowId), Property.elementChildNodes);
		return this.#ofKind(children, Jcid.tableCellNode);
	}

	/**
	 * One cell, written straight into the row.
	 *
	 * `renderCell` builds the cell's text, collapses its whitespace, escapes
	 * its pipes and trims it — four operations over a string that is as large
	 * as the cell. None of them needs the string: collapsing a run of
	 * whitespace to one space is a flag, escaping a pipe is a substitution of
	 * one character for two, and trimming is the same flag held at both ends.
	 * `CellText` is those three as one filter, so a cell holding a megabyte of
	 * text costs a chunk of it.
	 */
	async #cell(cellId: IndexedGuid | undefined, depth: number, path: Set<string>): Promise<void> {
		if (!cellId) return;

		const out = new CellText(text => this.#note.push(text));
		const children = this.#children(this.#doc.viewOf(cellId), Property.elementChildNodes);
		await this.#writeChildren(children, depth, path, out);
		// Whatever whitespace `out` is still holding was trailing after all,
		// and dropping it is what `trim` did to it.
	}

	/**
	 * What a cell's children contribute, in order.
	 *
	 * `renderCell` collects a part per child, drops the empty ones and joins
	 * the rest with a space. A part is dropped for being empty and not for
	 * being blank, so what matters about a part is whether it produced any
	 * character at all — which `CellText` tracks with a boolean, and which is
	 * why the nesting can be flattened: joining non-empty parts with single
	 * spaces gives the same string however the parts were grouped.
	 */
	async #writeChildren(
		children: Children,
		depth: number,
		path: Set<string>,
		out: CellText,
	): Promise<void> {
		if (depth >= this.#options.maxPropertySetDepth) return;

		for (let index = 0; index < children.count; index++) {
			const object = this.#doc.object(children.at(index));
			if (!object) continue;

			switch (object.jcid) {
				case Jcid.richTextNode:
					// A rich-text node contributes its runs and nothing else;
					// the children a paragraph appears to have came from the
					// outline element above it.
					out.beginPart();
					await this.#runs(this.#doc.view(object), out);
					out.endPart();
					break;

				case Jcid.outlineElementNode: {
					// The element folds into its primary child, so a cell sees
					// the paragraph rather than the element that carried it.
					// The list level and tags it also carries have nowhere to go
					// in a table cell, which is why they are dropped here.
					const view = this.#doc.view(object);
					const content = this.#children(view, Property.contentChildNodes);

					for (let at = 0; at < content.count; at++) {
						const contentId = content.at(at);
						const candidate = this.#doc.object(contentId);
						if (!candidate) continue;

						if (candidate.jcid === Jcid.inkContainer) {
							if (this.#ink(candidate)) break;
							continue;
						}

						if (HANDLED.has(candidate.jcid)) {
							await this.#writeChildren(one(contentId), depth + 1, path, out);
							break;
						}
					}

					await this.#writeChildren(
						this.#children(view, Property.elementChildNodes), depth + 1, path, out);
					break;
				}

				case Jcid.outlineNode:
				case Jcid.outlineGroup:
					await this.#writeChildren(
						this.#children(this.#doc.view(object), Property.elementChildNodes),
						depth + 1, path, out);
					break;

				case Jcid.imageNode:
					await out.part(await this.#imageLink(object) ?? '');
					break;

				case Jcid.embeddedFileNode:
					await out.part(await this.#embeddedFileLink(object) ?? '');
					break;

				case Jcid.inkContainer:
					this.#ink(object);
					break;

				case Jcid.tableNode:
					this.#page.onSkipped?.(this.#page.noteName, 'not-representable');
					break;

				default:
					break;
			}
		}
	}

	// -- Assets -------------------------------------------------------------

	async #image(object: ObjectDescriptor): Promise<void> {
		const link = await this.#imageLink(object);
		if (link) {
			await this.#note.beginBlock(false);
			await this.#note.push(link);
		}
	}

	async #imageLink(object: ObjectDescriptor): Promise<string | undefined> {
		const view = this.#doc.view(object);
		const fileName = readString(view, Property.imageFilename, this.#limits.maxValueChars, 'An image file name', this.#limits.meter);
		const container = this.#container(view, Property.pictureContainer);

		const name = withExtension(
			`${this.#page.noteName} image`,
			container?.extension ?? extensionFromName(fileName) ?? undefined);

		return this.#asset(container?.range, name, '', true);
	}

	async #embeddedFile(object: ObjectDescriptor): Promise<void> {
		const link = await this.#embeddedFileLink(object);
		if (link) {
			await this.#note.beginBlock(false);
			await this.#note.push(link);
		}
	}

	async #embeddedFileLink(object: ObjectDescriptor): Promise<string | undefined> {
		const view = this.#doc.view(object);
		const fileName = readString(view, Property.embeddedFileName, this.#limits.maxValueChars, 'An embedded file name', this.#limits.meter);
		const container = this.#container(view, Property.embeddedFileContainer);
		const name = withExtension(fileName ?? 'attachment', container?.extension);

		return this.#asset(container?.range, name, name, false);
	}

	/** The first container a property names, with its bytes and extension. */
	#container(view: PropertySetView | undefined, propertyId: number) {
		for (const containerId of references(view, propertyId)) {
			const object = this.#doc.object(containerId);
			if (!object) continue;

			const containerView = this.#doc.view(object);
			return {
				extension: readString(
					containerView, Property.fileDataExtension,
					this.#limits.maxValueChars, 'A file extension', this.#limits.meter) ?? object.fileExtension,
				range: this.#resolver.fileDataRangeOf(object),
			};
		}

		return undefined;
	}

	async #asset(
		range: { offset: number, length: number } | undefined,
		name: string,
		label: string,
		embed: boolean,
	): Promise<string | undefined> {
		if (!range || range.length === 0) {
			this.#page.onSkipped?.(name, 'no-data');
			return undefined;
		}

		const attachment = await this.#assets.save(
			rangeStream(this.#resolver.window, range),
			name,
			this.#page.attachmentsDir,
			this.#page.linkPrefix);

		if (!attachment) {
			this.#page.onSkipped?.(name, 'no-data');
			return undefined;
		}

		const target = encodeURI(attachment.path);
		return embed ? `![${label}](${target})` : `[${label}](${target})`;
	}

	// -- Ink ----------------------------------------------------------------

	/** Gather one ink container's strokes. Answers whether any were usable. */
	#ink(object: ObjectDescriptor): boolean {
		const words = this.#inkInto(object, this.#strokes);
		if (words === undefined) return false;

		// Recognition text is repeated on every stroke in a word.
		if (words !== '' && words !== this.#lastRecognized) {
			this.#spills.recognized.writeText(this.#recognizedCount === 0 ? words : ` ${words}`);
			this.#recognizedCount++;
			this.#lastRecognized = words;
		}

		return true;
	}

	/**
	 * Decode a container's strokes into `strokes`, and answer its recognized
	 * words — or nothing at all, if it drew nothing.
	 *
	 * Where the strokes go is the caller's choice because a title's ink is
	 * decoded and discarded while a page's ink becomes a file.
	 */
	#inkInto(object: ObjectDescriptor, strokes: StrokeCollector): string | undefined {
		const view = this.#doc.view(object);
		const inkDataId = firstReference(view, Property.inkData);
		if (!inkDataId) return undefined;

		const inkData = this.#doc.object(inkDataId);
		if (inkData?.jcid !== Jcid.inkDataNode) return undefined;

		const scaleX = readFloat(view, Property.inkScalingX) ?? 1;
		const scaleY = readFloat(view, Property.inkScalingY) ?? 1;
		const inkView = this.#doc.view(inkData);

		let drawn = 0;
		let words = '';

		for (const strokeId of references(inkView, Property.inkStrokes)) {
			const stroke = this.#doc.object(strokeId);
			if (stroke?.jcid !== Jcid.inkStrokeNode) continue;

			if (!this.#stroke(stroke, scaleX, scaleY, strokes)) continue;
			drawn++;

			const recognized = this.#recognizedWord(strokeId);
			if (!recognized) continue;

			// Under the ceiling as an aggregate, not just word by word.
			//
			// Recognition text repeats per stroke in a word, so a page of
			// handwriting has thousands of strokes and this string grew with
			// all of them — past the reserve the budget set aside for it, with
			// nothing to say so.
			words = joinBounded(
				words, recognized, this.#limits.maxValueChars,
				'A drawing\'s recognized text', this.#limits.meter);
		}

		return drawn === 0 ? undefined : words;
	}

	#stroke(object: ObjectDescriptor, scaleX: number, scaleY: number, strokes: StrokeCollector): boolean {
		const view = this.#doc.view(object);
		const propertiesId = firstReference(view, Property.inkStrokeProperties);
		const properties = propertiesId ? this.#doc.object(propertiesId) : undefined;
		if (properties?.jcid !== Jcid.strokePropertiesNode) return false;

		const pathData = dataRange(view, Property.inkPath);
		if (!pathData) return false;

		const propertyView = this.#doc.view(properties);
		const dimensionRange = dataRange(propertyView, Property.inkDimensions);

		// One record at a time, because only the count and two indexes are
		// wanted and a record is thirty-two bytes. The table's length comes
		// from the property, so reading it whole meant either an allocation a
		// file could choose or a ceiling invented to forbid one.
		const dimensions = readInkDimensions(
			dimensionRange && dimensionRange.length > 0
				? new RangeReader(this.#resolver.window, dimensionRange)
				: undefined,
			InkDimensionId.x,
			InkDimensionId.y);

		if (dimensions.xIndex < 0 || dimensions.yIndex < 0) return false;

		// Read before the path, because reading a property moves the window and
		// the path walk below wants it left where it put it.
		const transparency = readUInt32Property(propertyView, Property.inkTransparency) ?? 0;
		const width = Math.max(0.000001,
			(readFloat(propertyView, Property.inkWidth) ?? 1) * Math.abs(scaleX) / NATIVE_UNITS_PER_HALF_INCH);

		// Opening the stroke before the path is decoded is safe because opening
		// one only notes where its points will start; a path that fails to
		// decode throws, which fails the page, so no half-stroke is ever drawn.
		const first = strokes.beginStroke();

		const drawn = decodeInkPath(
			new RangeReader(this.#resolver.window, pathData),
			this.#spills.inkCoordinates.chunkBytes,
			this.#spills.inkCoordinates,
			dimensions.count,
			dimensions.xIndex,
			dimensions.yIndex,
			Math.min(this.#options.maxInkPathValues, pathData.length * 8),
			(x, y) => strokes.pushPoint(
				x * scaleX / NATIVE_UNITS_PER_HALF_INCH * PIXELS_PER_INK_UNIT,
				y * scaleY / NATIVE_UNITS_PER_HALF_INCH * PIXELS_PER_INK_UNIT));

		if (!drawn) return false;

		strokes.endStroke(
			first,
			decodeInkColor(readUInt32Property(propertyView, Property.inkColor)),
			Math.max(1, width * PIXELS_PER_INK_UNIT),
			1 - Math.min(255, transparency) / 255);

		return true;
	}

	async #writeCollectedInk(): Promise<void> {
		if (!writeInkSvg(this.#strokes, this.#spills.inkDocument)) return;

		const attachment = await this.#assets.save(
			spoolStream(this.#spills.inkDocument),
			`${this.#page.noteName} - Ink.svg`,
			this.#page.attachmentsDir,
			this.#page.linkPrefix);

		if (attachment) {
			await this.#note.beginBlock(false);
			await this.#note.push(`![](${encodeURI(attachment.path)})`);
		}
		else this.#page.onSkipped?.(`${this.#page.noteName} - Ink.svg`, 'no-data');

		if (this.#recognizedCount > 0) {
			await this.#note.beginBlock(false);
			for (const piece of this.#spills.recognized.text()) await this.#note.push(piece);
		}
	}

	// -- Recognition --------------------------------------------------------

	/**
	 * Which handwritten word each stroke belongs to.
	 *
	 * The eager reader builds a map with one entry per stroke and keeps it for
	 * the page. This writes the same entries into the store, keyed by the page's
	 * slot, so the page's own resolution and its recognition share a lifetime.
	 */
	#collectRecognition(pageView: PropertySetView | undefined): void {
		const rootId = firstReference(pageView, Property.pageRecognizedTextContainer);
		if (!rootId) return;

		this.#walkRecognition(rootId, 0);
	}

	#walkRecognition(id: IndexedGuid, depth: number): void {
		if (depth > 8) return;

		const visited = this.#key.reset(StoreTag.recognitionVisited)
			.u32(this.#recognitionSlot).extendedGuid(id).done();
		if (this.#store.has(visited)) return;
		this.#store.set(visited, EMPTY);

		const object = this.#doc.object(id);
		if (!object) return;
		const view = this.#doc.view(object);

		if (object.jcid === Jcid.recognizedTextWord) {
			const word = this.#firstAlternative(view);
			const referenceRange = dataRange(view, Property.recognizedTextStrokeReferences);
			if (!word || !referenceRange) return;

			const reader = new RangeReader(this.#resolver.window, referenceRange);
			for (let offset = 0; offset + 20 <= referenceRange.length; offset += 20) {
				const stroke = { identifier: id.identifier, value: reader.u32(offset + 16) };
				const value = this.#value.reset().text(word).done();
				this.#store.set(
					this.#key.reset(StoreTag.recognition).u32(this.#recognitionSlot).extendedGuid(stroke).done(),
					value);
			}
			return;
		}

		const children = this.#children(view, Property.recognizedTextChildNodes);
		for (let index = 0; index < children.count; index++) {
			this.#walkRecognition(children.at(index), depth + 1);
		}
	}

	/** The first non-empty alternative of a recognized word. */
	#firstAlternative(view: PropertySetView | undefined): string | undefined {
		const range = dataRange(view, Property.recognizedText);
		if (!range || range.length < 2) return undefined;

		let current = '';
		for (const piece of utf16Text(view!.window, range, 0, range.length >>> 1)) {
			for (const character of piece) {
				if (character !== '\0') {
					// A recognized word is a word, and it is written into the
					// store per stroke that refers to it.
					if (current.length >= this.#limits.maxValueChars) {
						throw overValueLimit(
							'A recognized handwriting alternative', current.length + 1,
							this.#limits.maxValueChars, 'maxValueChars');
					}
					current += character;
					continue;
				}
				if (current !== '') return current;
			}
		}

		this.#limits.meter?.value(current.length);
		return current !== '' ? current : undefined;
	}

	#recognizedWord(strokeId: IndexedGuid): string | undefined {
		const stored = this.#store.get(
			this.#key.reset(StoreTag.recognition).u32(this.#recognitionSlot).extendedGuid(strokeId).done());
		return stored ? new RecordReader(stored).text() : undefined;
	}
}

const HYPERLINK_WORD = 'HYPERLINK';

interface HyperlinkField {
	start: number;
	length: number;
	url: string;
}

const HANDLED = new Set<number>([
	Jcid.outlineNode,
	Jcid.outlineGroup,
	Jcid.outlineElementNode,
	Jcid.richTextNode,
	Jcid.imageNode,
	Jcid.embeddedFileNode,
	Jcid.tableNode,
	Jcid.inkContainer,
]);

/** Where a rendered run goes: into a note's block, or into a table cell. */
export interface RunTarget {
	push(text: string): Promise<void>;
}

/**
 * A table cell's text, normalized as it is written.
 *
 * This is `text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()` and the
 * `parts.filter(part => part !== '').join(' ')` above it, as one pass. All four
 * are local:
 *
 *   - a run of whitespace becomes one space, which is a flag until the next
 *     character says whether the space is interior or trailing;
 *   - a pipe becomes two characters, decided per character;
 *   - the leading and trailing whitespace go, which is the same flag held at
 *     the start and never released at the end;
 *   - the space between parts is emitted as whitespace and therefore collapses
 *     with whatever is beside it, exactly as it did when the parts were joined
 *     before being collapsed.
 *
 * `\s` here is `text.ts`'s set, which is the one both `replace` and `trim` use.
 */
export class CellText implements RunTarget {
	/** Whitespace seen and not yet emitted: interior until proven trailing. */
	#pendingSpace = false;
	/** Whether anything has survived the leading trim. */
	#seenContent = false;
	/** Whether the current part has produced a character. */
	#produced = false;
	/** Whether an earlier part did, which is what a separator needs. */
	#anyProduced = false;

	constructor(private readonly emit: (text: string) => Promise<void>) {}

	beginPart(): void {
		this.#produced = false;
	}

	endPart(): void {
		if (this.#produced) this.#anyProduced = true;
		this.#produced = false;
	}

	/** A part that arrives whole, such as an attachment link. */
	async part(text: string): Promise<void> {
		this.beginPart();
		await this.push(text);
		this.endPart();
	}

	async push(text: string): Promise<void> {
		if (text === '') return;

		// The first character of a part is where the join goes, and it goes in
		// as whitespace so that the collapsing rule applies to it too.
		if (!this.#produced) {
			this.#produced = true;
			if (this.#anyProduced) this.#pendingSpace = true;
		}

		// Bounded by the piece, which is a chunk of a property or a link.
		let out = '';

		for (let index = 0; index < text.length; index++) {
			if (isWhitespace(text.charCodeAt(index))) {
				this.#pendingSpace = true;
				continue;
			}

			if (this.#pendingSpace) {
				this.#pendingSpace = false;
				if (this.#seenContent) out += ' ';
			}

			this.#seenContent = true;
			out += text[index] === '|' ? '\\|' : text[index];
		}

		if (out !== '') await this.emit(out);
	}
}

/**
 * One run's markers and escaping.
 *
 * `renderRun` splits the run into leading whitespace, a core and trailing
 * whitespace, and only the core is wrapped and escaped. Streaming it means
 * holding the whitespace until it is known whether a core follows — so a run
 * that is entirely whitespace passes through untouched, as it does upstream.
 */
class CoreWriter {
	/**
	 * The run's leading whitespace before it opens, its trailing whitespace
	 * after. Never both, since opening is what ends the first and starts the
	 * second, so one region serves for the two of them.
	 */
	readonly #held: TextSpill;
	#opened = false;

	constructor(
		private readonly style: RunStyle,
		private readonly resolveInternalLink: ((title: string) => string) | undefined,
		private readonly into: RunTarget,
		held: TextSpill,
	) {
		this.#held = held;
		this.#held.clear();
	}

	async push(piece: string): Promise<void> {
		let start = 0;

		if (!this.#opened) {
			while (start < piece.length && isWhitespace(piece.charCodeAt(start))) start++;
			this.#held.append(piece.slice(0, start));
			if (start === piece.length) return;
		}

		let end = piece.length;
		while (end > start && isWhitespace(piece.charCodeAt(end - 1))) end--;

		if (end > start) {
			if (!this.#opened) {
				await this.#emitHeld(false);
				await this.into.push(this.#prefix());
				this.#opened = true;
			}
			else if (!this.#held.isEmpty) {
				await this.#emitHeld(true);
			}

			await this.into.push(escapeInline(piece.slice(start, end)));
		}

		if (end < piece.length) this.#held.append(piece.slice(end));
	}

	async finish(): Promise<void> {
		if (!this.#opened) {
			// An all-whitespace run is its own leading whitespace, and nothing
			// else: `renderRun` returns `leading + '' + ''` for it.
			await this.#emitHeld(false);
			return;
		}

		await this.into.push(this.#suffix());
		await this.#emitHeld(false);
	}

	/** The held whitespace, in the pieces the spill hands back. */
	async #emitHeld(escape: boolean): Promise<void> {
		if (this.#held.isEmpty) return;
		// Escaping is per character, so a piece can be escaped on its own; and
		// nothing `escapeInline` touches is whitespace, so this is the identity
		// either way. It is applied because the string version applies it.
		for (const piece of this.#held.pieces()) await this.into.push(escape ? escapeInline(piece) : piece);
		this.#held.clear();
	}

	/** A maths run, whose core cannot be produced a piece at a time. */
	async whole(text: string): Promise<void> {
		const leading = text.match(/^\s*/)![0];
		const trailing = text.length > leading.length ? text.match(/\s*$/)![0] : '';
		const core = text.slice(leading.length, text.length - trailing.length);

		if (core === '') {
			if (text !== '') await this.into.push(text);
			return;
		}

		// Formatting around maths would end up inside its delimiters.
		const latex = toLatex(core);
		if (latex === '') return;
		await this.into.push(`${leading}$${latex}$${trailing}`);
	}

	/**
	 * The markers that go before the core.
	 *
	 * `renderRun` wraps the core one style at a time, innermost first, so the
	 * opening markers come out in the reverse of the order they are applied:
	 * a bold link is `[**`, not `**[`.
	 */
	#prefix(): string {
		let prefix = '';
		if (this.style.hyperlinkUrl) prefix += '[';
		if (this.style.strikethrough) prefix += '~~';
		if (this.style.italic) prefix += '*';
		if (this.style.bold) prefix += '**';
		if (this.style.underline) prefix += '<u>';
		if (this.style.subscript) prefix += '<sub>';
		if (this.style.superscript) prefix += '<sup>';
		if (this.style.highlight) prefix += highlightPrefix(this.style.highlight);
		return prefix;
	}

	#suffix(): string {
		let suffix = '';
		if (this.style.highlight) suffix += '==';
		if (this.style.superscript) suffix += '</sup>';
		if (this.style.subscript) suffix += '</sub>';
		if (this.style.underline) suffix += '</u>';
		if (this.style.bold) suffix += '**';
		if (this.style.italic) suffix += '*';
		if (this.style.strikethrough) suffix += '~~';
		if (this.style.hyperlinkUrl) suffix += `](${encodeURI(this.#target())})`;
		return suffix;
	}

	#target(): string {
		const pageTitle = internalPageTitle(this.style.hyperlinkUrl!);
		return pageTitle
			? this.resolveInternalLink?.(pageTitle) ?? pageTitle
			: this.style.hyperlinkUrl!;
	}
}

/**
 * A paragraph's body: trimmed, split into lines, each line escaped.
 *
 * The block is not opened until a character survives the trim, which is how a
 * paragraph of nothing but whitespace leaves no empty block behind.
 */
class BlockBody implements RunTarget {
	readonly #note: NoteWriter;
	readonly #line: TextSpill;
	readonly #returns: CarriageReturnFilter;
	readonly #trimmer: Trimmer;
	readonly #prefix: string;
	readonly #indent: string;
	readonly #open: () => Promise<void>;

	#opened = false;
	#firstLine = true;

	constructor(
		note: NoteWriter,
		spills: SpillSet,
		prefix: string,
		indent: string,
		open: () => Promise<void>,
	) {
		this.#note = note;
		this.#prefix = prefix;
		this.#indent = indent;
		this.#open = open;
		this.#line = spills.line;
		this.#line.clear();
		this.#trimmer = new Trimmer(piece => this.#accept(piece), spills.paragraph);
		this.#returns = new CarriageReturnFilter(piece => this.#trimmer.push(piece));
	}

	async push(text: string): Promise<void> {
		await this.#returns.push(text);
	}

	async finish(): Promise<boolean> {
		await this.#returns.finish();
		await this.#trimmer.finish();
		if (this.#opened) await this.#flushLine();
		return this.#opened;
	}

	async #accept(piece: string): Promise<void> {
		if (!this.#opened) {
			await this.#open();
			await this.#note.push(this.#prefix);
			this.#opened = true;
		}

		let start = 0;
		for (;;) {
			const newline = piece.indexOf('\n', start);
			if (newline < 0) break;

			this.#line.append(piece.slice(start, newline));
			await this.#flushLine();
			start = newline + 1;
		}

		this.#line.append(piece.slice(start));
	}

	async #flushLine(): Promise<void> {
		if (!this.#firstLine) await this.#note.push(HARD_BREAK + this.#indent);
		this.#firstLine = false;

		const { matched, whitespaceLength } = decideLineStart(this.#line.pieces());
		let emitted = 0;

		for (const piece of this.#line.pieces()) {
			if (matched && emitted <= whitespaceLength && emitted + piece.length >= whitespaceLength) {
				const at = whitespaceLength - emitted;
				await this.#note.push(`${piece.slice(0, at)}\\${piece.slice(at)}`);
			}
			else await this.#note.push(piece);

			emitted += piece.length;
		}

		if (matched && emitted < whitespaceLength) await this.#note.push('\\');
		this.#line.clear();
	}
}

// -- Shared rules ----------------------------------------------------------

function escapeInline(text: string): string {
	return text.replace(/[[\]`<]/g, '\\$&');
}

function scriptRuns(text: string, glyphs: string, plain: string, marker: string): string {
	const pattern = new RegExp(`[${glyphs}]+`, 'g');

	return text.replace(pattern, match => {
		const decoded = [...match].map(character => plain[glyphs.indexOf(character)]).join('');
		return `${marker}{${decoded}}`;
	});
}

function toLatex(text: string): string {
	const scripted = scriptRuns(
		scriptRuns(text, SUPERSCRIPTS, SUPERSCRIPT_PLAIN, '^'),
		SUBSCRIPTS, SUBSCRIPT_PLAIN, '_');

	return scripted.normalize('NFKC').replace(INVISIBLE_MATH, '').trim();
}

/** Extracts `Page title` from `onenote:...#Page%20title&section-id=...`. */
function internalPageTitle(url: string): string | undefined {
	if (!url.toLowerCase().startsWith('onenote:')) return undefined;

	const hash = url.indexOf('#');
	if (hash < 0) return undefined;

	const tail = url.slice(hash + 1);
	const separator = tail.indexOf('&');
	const encoded = tail.slice(0, separator < 0 ? tail.length : separator);
	if (encoded === '') return undefined;

	try {
		return decodeURIComponent(encoded);
	}
	catch {
		return encoded;
	}
}

function highlightPrefix(color: string): string {
	const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
	if (!match) return '==';

	const [red, green, blue] = match.slice(1).map(part => parseInt(part, 16));

	let nearest = HIGHLIGHT_MARKERS[0].marker;
	let best = Infinity;

	for (const { marker, inks } of HIGHLIGHT_MARKERS) {
		for (const [inkRed, inkGreen, inkBlue] of inks) {
			const distance = (inkRed - red) ** 2 + (inkGreen - green) ** 2 + (inkBlue - blue) ** 2;
			if (distance < best) {
				best = distance;
				nearest = marker;
			}
		}
	}

	return `==${nearest}`;
}

/** OneNote stores colors as 0x00BBGGRR. */
function highlightColor(color: number | undefined): string | undefined {
	if (color === undefined || (color & 0xff000000) !== 0) return undefined;
	if ((color & 0xffffff) === 0xffffff) return undefined;

	const channel = (shift: number) => ((color >> shift) & 0xff).toString(16).padStart(2, '0');
	return `#${channel(0)}${channel(8)}${channel(16)}`;
}

function headingPrefix(styleId: string | undefined): string {
	const level = styleId?.match(/^h([1-6])$/i);
	return level ? '#'.repeat(Number(level[1])) + ' ' : '';
}

function listPrefix(list: ListInfo | undefined): string {
	if (!list) return '';
	return '\t'.repeat(list.level) + (list.ordered ? '1. ' : '- ');
}

function taskPrefix(tags: Tag[] | undefined, list: ListInfo | undefined): string | undefined {
	const task = tags?.find(tag => tag.checkable);
	if (!task) return undefined;

	return '\t'.repeat(list?.level ?? 0) + (task.completed ? '- [x] ' : '- [ ] ');
}

interface Callout {
	type: string;
	title?: string;
}

function calloutFor(tags: Tag[] | undefined): Callout | undefined {
	for (const tag of tags ?? []) {
		if (tag.checkable || tag.shape === undefined) continue;

		const type = CALLOUT_SHAPES[tag.shape];
		if (type) return { type, title: tag.label };
	}

	return undefined;
}

function isCheckableShape(shape: number): boolean {
	if (shape >= 1 && shape <= 12) return true;
	if (shape === 28 || shape === 30 || shape === 32) return true;
	if (shape === 48 || shape === 50 || shape === 52) return true;
	if (shape === 69 || shape === 71 || shape === 73) return true;
	return shape >= 89 && shape <= 99;
}

/** An attachment without an extension is one the vault cannot open. */
function withExtension(base: string, extension: string | undefined): string {
	if (!extension) return base;
	if (extensionFromName(base)) return base;
	return base + (extension.startsWith('.') ? extension : `.${extension}`);
}

export { OneNoteFormatError };
