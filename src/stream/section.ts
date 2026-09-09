/**
 * A section, opened rather than read.
 *
 * `readSection` returns a `Section` with its pages in it, which is the shape
 * everything downstream was written against and also the reason a large
 * notebook needs a large machine: the whole section is in heap before the
 * first note is written.
 *
 * This is the same information behind a different door. Opening a section
 * indexes it and resolves its section object space, which is bounded work
 * against a bounded index. The pages are then a sequence: each one resolves
 * its own object space when it is reached, renders, and is released before the
 * next is resolved. What is held across pages is a resolver, an index, and the
 * page's identifier — not its content.
 *
 * `mapSection` remains the definition of which spaces are pages and in what
 * order. This walks the same properties in the same order.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { ReaderOptions } from '../onenote-file/onestore/options';
import { Jcid, Property } from '../onenote-file/semantic/schema';
import { indexSection } from '../indexing/index-section';
import {
	DEFAULT_SECTION_INDEX_OPTIONS,
	IndexedGuid,
	ObjectDescriptor,
	SectionIndex,
	SectionIndexOptions,
	SectionIndexStats,
} from '../indexing/section-index';
import { ResolvedSpace, SpaceResolver } from '../resolve/space';
import {
	dataRange,
	readBoolean,
	readFileTime,
	readString,
	readTime32,
	readUInt32Property,
	references,
} from '../resolve/values';
import { ByteSource } from '../storage/byte-source';
import { RecordWriter } from '../storage/records';
import { PagedKeyValueStore } from '../storage/paged-key-value-store';
import { AssetWriter } from './assets';
import { NoteWriter } from './markdown';
import { PageRenderer, PageRenderOptions } from './page';
import { ChunkWriter } from './sink';
import { SpillSet } from './spills';
import { ResidentAccount } from './account';
import { DEFAULT_VALUE_RESERVE_BYTES, limitsFor, StreamLimits } from './limits';

/**
 * Where the property views' keys start in the conversion store.
 *
 * The resolver, the property views, the renderer and the spools all key into
 * one store, so they share one page-cache budget and one temporary file. Two of
 * them using one tag would corrupt both, so the ranges are fixed:
 *
 *     1–31   `SpaceResolver`, for revisions, cells, slots and CompactIDs
 *     32–39  `PropertyStore`, for parsed sets and their properties
 *     40–59  `PageRenderer`, for handwriting recognition
 *     59     `StreamSection`, for the pages a walk has already reached
 *     60–     `SpillSet`, one per spool
 *
 * They are listed here because this is the only place that constructs all four.
 */
const PROPERTY_TAG_BASE = 32;

/** Where a walk records the page spaces it has already reached. */
const VISITED_PAGE_TAG = 59;

const EMPTY = new Uint8Array(0);

/** What `onOpen` returns when there is no `onOpen`. */
const noRelease = (): void => {};

export interface StreamSectionOptions extends SectionIndexOptions {
	/** Descriptor pages the conversion's own store may hold resident. */
	conversionCacheBytes?: number;
	/** UTF-16 units a text spill holds before the rest goes to the store. */
	spillChars?: number;
	/** Bytes a spool holds before flushing a chunk to the store. */
	chunkBytes?: number;
	/** Bytes between a note writer and its sink. */
	noteBufferBytes?: number;
	/**
	 * Bytes held for the values that cannot be streamed.
	 *
	 * The ceilings in `limits` are derived from this, so that the largest title
	 * or maths run a conversion will accept is one the caller has set bytes
	 * aside for. A budget supplies both together; a caller who states neither
	 * gets `DEFAULT_VALUE_RESERVE_BYTES`, which is generous.
	 */
	valueReserveBytes?: number;
	/**
	 * Somewhere to register this section's stores and window, for diagnostics.
	 *
	 * Optional and O(1): the account holds references to things that already
	 * exist and reads their own high-water counters. Absent by default.
	 */
	account?: ResidentAccount;
	/**
	 * Somewhere to register the stores this section opens, for a forced exit.
	 *
	 * A section closes its own stores, and a failure inside it closes them on
	 * the way out — so this is not about the ordinary paths. It is about the
	 * exit that does not have one: a second Ctrl-C calls `process.exit`, and
	 * nothing between here and there gets a chance to run. Whoever owns that
	 * exit needs to know what is open, and this is how it finds out.
	 *
	 * Returns a release, called when the section closes normally, so nothing
	 * stays registered longer than it exists.
	 */
	onOpen?: (what: string, close: () => void) => (() => void);
	/**
	 * Ceilings on the few values that have to become values.
	 *
	 * Derived from the cache budget when not given. See `limits.ts` for what
	 * they cover and why those things cannot be streamed.
	 */
	limits?: Partial<StreamLimits>;
}

/** A page's metadata, which is all that is known before it is rendered. */
export interface StreamPage {
	id: string;
	title: string;
	level: number;
	createdUtc?: Date;
	lastModifiedUtc?: Date;
	isConflictPage: boolean;
	isDeleted: boolean;
	/** Write the body into `note`. The page is resolved when this is called. */
	render(note: NoteWriter, options: PageRenderOptions): Promise<void>;
}

export interface StreamSectionStats {
	readonly index: SectionIndexStats;
	/** Bytes the conversion's own store holds resident. */
	readonly conversionCacheBytes: number;
	/** Index and conversion together: what one section costs while converting. */
	readonly residentBytes: number;
}

export class StreamSection {
	readonly name: string;
	readonly colorArgb?: number;
	readonly index: SectionIndex;

	readonly #resolver: SpaceResolver;
	readonly #store: PagedKeyValueStore;
	/** Deregistrations for whoever is watching for a forced exit. */
	readonly #releases: readonly (() => void)[];
	readonly #spills: SpillSet;
	readonly #renderer: PageRenderer;
	readonly #sectionSpace: ResolvedSpace;
	readonly #options: ReaderOptions;
	readonly #limits: StreamLimits;
	readonly #noteBufferBytes: number | undefined;
	readonly #key = new RecordWriter(32);

	/** Which walk of the pages is current, so repeats are per walk. */
	#walks = 0;

	private constructor(
		index: SectionIndex,
		store: PagedKeyValueStore,
		resolver: SpaceResolver,
		sectionSpace: ResolvedSpace,
		spills: SpillSet,
		renderer: PageRenderer,
		limits: StreamLimits,
		noteBufferBytes?: number,
		releases: readonly (() => void)[] = [],
	) {
		this.#releases = releases;
		this.index = index;
		this.#limits = limits;
		this.#noteBufferBytes = noteBufferBytes;
		this.#store = store;
		this.#resolver = resolver;
		this.#sectionSpace = sectionSpace;
		this.#spills = spills;
		this.#renderer = renderer;
		this.#options = index.options;

		const metadata = sectionSpace.root(2);
		const metadataView = sectionSpace.properties(metadata);

		this.name = metadata?.jcid === Jcid.sectionMetadata
			? readString(
				metadataView, Property.sectionDisplayName,
				limits.maxValueChars, 'A section display name', limits.meter) ?? ''
			: '';
		this.colorArgb = metadata?.jcid === Jcid.sectionMetadata
			? readUInt32Property(metadataView, Property.notebookColor)
			: undefined;
	}

	/**
	 * Index a section and resolve the space that describes it.
	 *
	 * Everything that fails because the artifact is not a section fails here,
	 * before any page is reached, which is what lets a caller treat a section
	 * that cannot be opened as one failure rather than as a failure per page.
	 */
	static open(
		source: ByteSource,
		assets: AssetWriter,
		options: StreamSectionOptions = {},
	): StreamSection {
		const index = indexSection(source, options);
		const releaseIndex = options.onOpen?.('the section index', () => index.close()) ?? noRelease;

		try {
			const cacheBytes = options.conversionCacheBytes
				?? options.cacheBytes
				?? DEFAULT_SECTION_INDEX_OPTIONS.cacheBytes;
			// From the reserve, not from the cache: a ceiling worked out from
			// the size of a cache is a ceiling nothing has paid for.
			const limits = limitsFor(
				options.valueReserveBytes ?? DEFAULT_VALUE_RESERVE_BYTES,
				// A watching account supplies the meter, so the ceilings and the
				// observations come from one place.
				{ ...options.limits, meter: options.account?.meter ?? options.limits?.meter });

			const store = new PagedKeyValueStore({
				pageSize: options.pageSize ?? DEFAULT_SECTION_INDEX_OPTIONS.pageSize,
				cacheBytes,
				bucketCount: options.bucketCount ?? DEFAULT_SECTION_INDEX_OPTIONS.bucketCount,
				tempDirectory: options.tempDirectory,
			});

			const releaseStore = options.onOpen?.('the conversion store', () => store.close())
				?? noRelease;

			try {
				if (options.account) {
					options.account.addSectionCache(index, () => index.stats.cache.highWaterBytes);
					options.account.addSectionCache(store, () => store.cacheStats.highWaterBytes);
					options.account.addCopies(index, () => index.stats.cache.copyHighWaterBytes);
					options.account.addCopies(store, () => store.copyHighWaterBytes);
					options.account.setWindowBytes(index.stats.windowBytes);
				}

				const resolver = new SpaceResolver(index, index.window, store, PROPERTY_TAG_BASE);

				const sectionSpace = resolver.currentSpaceByRootJcid(Jcid.sectionNode);
				if (!sectionSpace) {
					throw new OneNoteFormatError(
						'ONENOTE_SECTION_OBJECT_SPACE',
						'No current section object space could be materialized.');
				}

				const root = sectionSpace.root(1);
				if (root?.jcid !== Jcid.sectionNode) {
					throw new OneNoteFormatError(
						'ONENOTE_SECTION_ROOT',
						'The current root object space does not resolve to a section node.');
				}

				const spills = new SpillSet(store, options.spillChars, options.chunkBytes);
				const renderer = new PageRenderer(resolver, store, spills, assets, index.options, limits);

				return new StreamSection(
					index, store, resolver, sectionSpace, spills, renderer, limits,
					options.noteBufferBytes, [releaseStore, releaseIndex]);
			}
			catch (error) {
				releaseStore();
				throw error;
			}
		}
		catch (error) {
			releaseIndex();
			throw error;
		}
	}

	/**
	 * A note writer over an open output file.
	 *
	 * The writer needs somewhere to hold back trailing whitespace, and that
	 * somewhere is the section's own scratch space — so it comes from here
	 * rather than from the caller, who would otherwise have to know that a
	 * trimmer spills.
	 */
	openNote(writer: ChunkWriter): NoteWriter {
		this.#spills.trailing.clear();
		return new NoteWriter(writer, this.#spills.trailing, this.#noteBufferBytes);
	}

	get stats(): StreamSectionStats {
		const index = this.index.stats;
		const conversion = this.#store.cacheStats.residentBytes;

		return {
			index,
			conversionCacheBytes: conversion,
			residentBytes: index.residentBytes + conversion,
		};
	}

	/**
	 * Count the pages a conversion will attempt without resolving titles or
	 * touching page bodies and assets.
	 *
	 * Exactness requires resolving each page space far enough to prove that it
	 * has the same manifest and page node `pages()` requires, and to read its
	 * deletion marker. Conversion resolves that metadata again on its second
	 * walk; keeping it would make the heap grow with the section. The visited
	 * identifiers for both walks stay in separate generations in the paged
	 * store instead.
	 *
	 * `undefined` means cancellation was requested. Yielding once per candidate
	 * keeps a large pre-count interruptible even though store reads are
	 * synchronous.
	 */
	async countPages(
		includeDeleted = false,
		isCancelled?: () => boolean,
	): Promise<number | undefined> {
		let count = 0;

		for (const spaceId of this.#pageSpaceIds()) {
			await new Promise<void>(resolve => { setImmediate(resolve); });
			if (isCancelled?.()) return undefined;

			const deleted = this.#pageDeletionState(spaceId);
			if (deleted !== undefined && (includeDeleted || !deleted)) count++;
		}

		return count;
	}

	/**
	 * The section's pages, one resolved at a time.
	 *
	 * Consuming this lazily is the point: the sequence holds a page's object
	 * space only while its element is current, so a section with ten thousand
	 * pages costs what its largest page costs, not what all of them do.
	 */
	*pages(): IterableIterator<StreamPage> {
		for (const spaceId of this.#pageSpaceIds()) {
			const page = this.#page(spaceId);
			if (page) yield page;
		}
	}

	/**
	 * Page-space identifiers in section order, unique within this traversal.
	 *
	 * Every call owns a generation in the disk-backed visited namespace. That
	 * makes the metadata pre-count and conversion independent without an
	 * unbounded heap Set or a store-wide reset.
	 */
	*#pageSpaceIds(): IterableIterator<IndexedGuid> {
		const root = this.#sectionSpace.root(1)!;
		const rootView = this.#sectionSpace.properties(root);

		// A page can be listed by more than one series, and `mapSection` skips
		// the repeats. Which pages have been reached goes in the store, keyed
		// by this walk, so a section with a hundred thousand pages costs a
		// counter rather than a hundred thousand identifiers — and so that a
		// second walk of the same section starts over, as a second call to
		// `mapSection` would.
		const walk = ++this.#walks;
		let visited = 0;

		for (const seriesId of references(rootView, Property.elementChildNodes)) {
			const series = this.#sectionSpace.object(seriesId);
			if (series?.jcid !== Jcid.pageSeriesNode) continue;

			const seriesView = this.#sectionSpace.properties(series);
			for (const spaceId of references(seriesView, Property.childGraphSpaceElementNodes)) {
				if (visited >= this.#options.maxPageGraphNodes) return;

				const key = this.#key.reset(VISITED_PAGE_TAG).u32(walk).extendedGuid(spaceId).done();
				if (this.#store.has(key)) continue;
				this.#store.set(key, EMPTY);
				visited++;
				yield spaceId;
			}
		}
	}

	close(): void {
		// Through the releases where there are any, because closing without
		// deregistering would leave the owner of the forced exit holding a
		// closed store — harmless, since closing twice is a no-op, but it
		// would grow with every section in a batch. The releases close what
		// they deregister, so this is one call rather than two.
		for (const release of this.#releases) release();

		this.#store.close();
		this.index.close();
	}

	/**
	 * One page's metadata, and a way to render it.
	 *
	 * The space is resolved here rather than in `render` because the title and
	 * the level decide the note's name and its folder, and both are needed
	 * before a byte is written. What that costs is the page's object map, which
	 * is in the store; the page's content is still untouched.
	 */
	#page(spaceId: IndexedGuid): StreamPage | undefined {
		const space = this.#resolver.tryGetSpace(spaceId);
		if (!space) return undefined;

		const manifest = space.root(1);
		if (manifest?.jcid !== Jcid.pageManifestNode) return undefined;

		const pageNode = this.#pageNodeOf(space, manifest);
		if (!pageNode) return undefined;

		const metadata = space.properties(space.root(2));
		const revisionMetadata = space.properties(space.root(4));
		const pageView = space.properties(pageNode);

		let title = readString(
			metadata, Property.cachedTitleString, this.#limits.maxValueChars, 'A page title', this.#limits.meter)
			?? readString(
				pageView, Property.cachedTitleStringFromPage,
				this.#limits.maxValueChars, 'A page title', this.#limits.meter)
			?? '';

		if (title.trim() === '') {
			this.#spills.resetForNote();
			title = this.#renderer.collectTitle(space, pageNode);
		}

		return {
			id: keyOf(spaceId),
			title,
			level: Math.max(0, (readUInt32Property(metadata, Property.pageLevel) ?? 1) - 1),
			createdUtc: readFileTime(metadata, Property.topologyCreationTimestamp),
			lastModifiedUtc: readFileTime(revisionMetadata, Property.lastModifiedTimestamp)
				?? readTime32(pageView, Property.lastModifiedTime),
			isConflictPage: readBoolean(metadata, Property.isConflictPage)
				?? space.root(2)?.jcid === Jcid.conflictPageMetadata,
			isDeleted: dataRange(metadata, Property.isDeletedGraphSpaceContent) !== undefined,
			render: async (note, options) => {
				this.#spills.resetForNote();
				await this.#renderer.render(space, pageNode, note, options);
			},
		};
	}

	/**
	 * The least metadata needed to decide whether `#page` would yield and
	 * whether conversion filters it. `undefined` means this is not a page.
	 */
	#pageDeletionState(spaceId: IndexedGuid): boolean | undefined {
		const space = this.#resolver.tryGetSpace(spaceId);
		if (!space) return undefined;

		const manifest = space.root(1);
		if (manifest?.jcid !== Jcid.pageManifestNode
			|| !this.#pageNodeOf(space, manifest)) return undefined;

		const metadata = space.properties(space.root(2));
		return dataRange(metadata, Property.isDeletedGraphSpaceContent) !== undefined;
	}

	#pageNodeOf(space: ResolvedSpace, manifest: ObjectDescriptor): ObjectDescriptor | undefined {
		const view = space.properties(manifest);
		for (const childId of references(view, Property.contentChildNodes)) {
			const candidate = space.object(childId);
			if (candidate?.jcid === Jcid.pageNode) return candidate;
		}

		return undefined;
	}
}

/**
 * A page's identifier, in the form `keyOf` gives an Extended GUID.
 *
 * It reaches front matter as `onenote-id`, so it has to be the same string the
 * eager path produces.
 */
function keyOf(id: IndexedGuid): string {
	return `${id.identifier}:${id.value}`;
}

