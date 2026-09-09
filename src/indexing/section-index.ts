/**
 * What a bounded-memory conversion reads instead of a parse tree.
 *
 * The existing readers answer "what is in this section?" by building it: a
 * `FileNodeList[]` and an `ObjectGraph` for a desktop section, a `WalkNode`
 * tree and a `DataElementPackage` for a packaged one. Both are proportional to
 * the section, and both hold decoded property sets, so a large section costs
 * heap several times its own size before a single page is written.
 *
 * An index answers the same question with fixed-size descriptors that name
 * where each structure lives. Nothing here holds bytes: an object's property
 * set, a file-data payload and a blob are all `ByteRange`s, fetched only when
 * something needs them. The descriptors themselves live in a temp-file-backed
 * paged store, so the number of revisions and objects a section contains moves
 * temporary disk, not heap.
 *
 * The two encodings index different structures — a desktop section has a
 * global-identification table and file-data store objects, a packaged one has
 * object partitions and blobs — but they agree on the three things the next
 * stage resolves: revisions, objects, and file data. Those live on the shared
 * `SectionIndex` below; what is genuinely specific to one encoding is reached
 * through `PackageSectionIndex`.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { FileHeader } from '../onenote-file/onestore/file-header';
import { DEFAULT_READER_OPTIONS, ReaderOptions } from '../onenote-file/onestore/options';
import { ByteRange } from '../storage/byte-source';
import { ByteWindow, DEFAULT_WINDOW_BYTES } from '../storage/byte-window';
import { PageCacheStats, PagedKeyValueStore } from '../storage/paged-key-value-store';
import { RecordGuid, RecordReader, RecordWriter } from '../storage/records';

export type SectionEncoding = 'revision-store' | 'file-synchronization-package';

/** An Extended GUID, as both encodings express it once normalized. */
export type IndexedGuid = RecordGuid;

export function indexedGuidKey(id: IndexedGuid): string {
	return `${id.identifier}:${id.value}`;
}

export interface RevisionDescriptor {
	/** Position in index order, and the handle every per-revision table uses. */
	order: number;
	id: IndexedGuid;
	dependencyId?: IndexedGuid;
	role: number;
	isEncrypted: boolean;
	contextId?: IndexedGuid;
	objectSpaceId?: IndexedGuid;
	rootObjectCount: number;
	roleAssociationCount: number;
	objectCount: number;
}

export interface RootObjectDescriptor {
	objectId: IndexedGuid;
	role: number;
}

export interface RoleAssociationDescriptor {
	contextId?: IndexedGuid;
	role: number;
	order: number;
}

export interface ObjectDescriptor {
	order: number;
	id: IndexedGuid;
	jcid: number;
	referenceCount: number;
	/** The revision that declared it, or -1 for one declared outside any. */
	revisionOrder: number;
	revisionId?: IndexedGuid;
	isRevision: boolean;
	/**
	 * Where the serialized property set lives. Absent when the object carries
	 * none: an encrypted desktop revision, or a packaged object that appears
	 * only in its metadata or file-data partition.
	 */
	propertySet?: ByteRange;
	/**
	 * Desktop only: which global-identification scope resolves this object's
	 * CompactIDs. Resolve one with `globalId(scope, index)`.
	 */
	globalIdScope?: number;
	/** Desktop only: a file-data declaration carries its reference inline. */
	fileDataReference?: string;
	fileExtension?: string;
	/**
	 * Packaged only: the counted Extended GUID array that resolves this
	 * object's CompactIDs, in place of a global-identification table.
	 */
	objectReferences?: ByteRange;
	objectReferenceCount?: number;
	/** Packaged only: the counted cell-identifier array beside it. */
	cellReferences?: ByteRange;
	cellReferenceCount?: number;
	/** Packaged only: the data element holding this object's file bytes. */
	blobId?: IndexedGuid;
}

export interface FileDataDescriptor {
	order: number;
	/**
	 * How the object that uses these bytes names them: the FileDataStoreObject
	 * GUID for a desktop section, the blob element's Extended GUID key for a
	 * packaged one.
	 */
	key: string;
	payload: ByteRange;
}

/** What an index cost to build, in the terms the memory budget is stated in. */
export interface SectionIndexStats {
	/** The page cache behind the on-disk descriptor tables. */
	readonly cache: PageCacheStats;
	/** The single sliding read buffer over the section. */
	readonly windowBytes: number;
	readonly windowRefills: number;
	/** Bytes held resident by the index itself: cache pages plus that buffer. */
	readonly residentBytes: number;
}

export interface SectionIndex {
	readonly encoding: SectionEncoding;
	readonly header: FileHeader;
	readonly options: ReaderOptions;
	readonly stats: SectionIndexStats;
	/**
	 * The single sliding buffer every range in this index is read through.
	 *
	 * Exposed because a consumer that resolves ranges — a property view, an
	 * attachment copy — must read them through the same window, or the one
	 * buffer this design rests on becomes several.
	 */
	readonly window: ByteWindow;

	readonly revisionCount: number;
	readonly objectCount: number;
	readonly fileDataCount: number;

	/** Materialize a named span. The only place an index hands back bytes. */
	read(range: ByteRange): Uint8Array;

	revisionAt(order: number): RevisionDescriptor;
	revision(id: IndexedGuid): RevisionDescriptor | undefined;
	revisions(): IterableIterator<RevisionDescriptor>;
	rootObjectsOf(revision: number): IterableIterator<RootObjectDescriptor>;
	roleAssociationsOf(revision: number): IterableIterator<RoleAssociationDescriptor>;
	objectsOf(revision: number): IterableIterator<ObjectDescriptor>;

	objectAt(order: number): ObjectDescriptor;
	object(id: IndexedGuid): ObjectDescriptor | undefined;
	objects(): IterableIterator<ObjectDescriptor>;

	fileDataAt(order: number): FileDataDescriptor;
	fileData(key: string): FileDataDescriptor | undefined;
	fileDataObjects(): IterableIterator<FileDataDescriptor>;

	/** Desktop only: the GUID a CompactID's global index stands for. */
	globalId(scope: number, index: number): string | undefined;
	/** Desktop only: that scope's table, in the shape a property set wants. */
	globalIdTable(scope: number): Map<number, string>;

	close(): void;
}

export interface SectionIndexOptions {
	reader?: ReaderOptions;
	/** Bytes of descriptor pages the index may hold resident. */
	cacheBytes?: number;
	pageSize?: number;
	bucketCount?: number;
	/** Bytes of the single sliding read buffer over the section. */
	windowBytes?: number;
	/** Where the run-owned temporary directory is created. */
	tempDirectory?: string;
}

export const DEFAULT_SECTION_INDEX_OPTIONS = {
	cacheBytes: 8 * 1024 * 1024,
	pageSize: 64 * 1024,
	bucketCount: 64 * 1024,
	windowBytes: DEFAULT_WINDOW_BYTES,
} as const;

/**
 * Namespaces inside the one paged store.
 *
 * Every key opens with a tag, so the shared tables below and an indexer's own
 * bookkeeping — visited sets, the committed-node counts, the packaged element
 * tables — share one store, one page cache and one budget. Tags at or above
 * `INDEXER_TAG_BASE` belong to whichever indexer built the index; the two
 * never coexist, so they are free to reuse the same numbers.
 */
const Tag = {
	revisionByOrder: 1,
	revisionByGuid: 2,
	revisionRoot: 3,
	revisionRole: 4,
	revisionObject: 5,
	objectByOrder: 6,
	objectByGuid: 7,
	fileDataByOrder: 8,
	fileDataByKey: 9,
	globalId: 10,
} as const;

export const INDEXER_TAG_BASE = 64;

function outOfRange(what: string, order: number, count: number): OneNoteFormatError {
	return new OneNoteFormatError(
		'ONENOTE_INDEX_OUT_OF_RANGE',
		`${what} ${order} was asked for, but the index holds ${count}.`);
}

/**
 * The concrete index: a paged store, a read window, and counters.
 *
 * Both indexers write through the `add*` methods and hand the finished object
 * back as a `SectionIndex`. The write side is deliberately not on that
 * interface — an index is immutable once built.
 */
export class IndexedSection implements SectionIndex {
	readonly encoding: SectionEncoding;
	readonly header: FileHeader;
	readonly options: ReaderOptions;
	readonly window: ByteWindow;
	readonly store: PagedKeyValueStore;

	readonly key = new RecordWriter(64);
	readonly value = new RecordWriter(256);

	#revisionCount = 0;
	#objectCount = 0;
	#fileDataCount = 0;
	#globalIdScopes = 0;

	constructor(
		encoding: SectionEncoding,
		header: FileHeader,
		window: ByteWindow,
		{ reader = DEFAULT_READER_OPTIONS, ...limits }: SectionIndexOptions = {},
	) {
		this.encoding = encoding;
		this.header = header;
		this.options = reader;
		this.window = window;
		this.store = new PagedKeyValueStore({
			pageSize: limits.pageSize ?? DEFAULT_SECTION_INDEX_OPTIONS.pageSize,
			cacheBytes: limits.cacheBytes ?? DEFAULT_SECTION_INDEX_OPTIONS.cacheBytes,
			bucketCount: limits.bucketCount ?? DEFAULT_SECTION_INDEX_OPTIONS.bucketCount,
			tempDirectory: limits.tempDirectory,
		});
	}

	get revisionCount(): number {
		return this.#revisionCount;
	}

	get objectCount(): number {
		return this.#objectCount;
	}

	get fileDataCount(): number {
		return this.#fileDataCount;
	}

	get globalIdScopeCount(): number {
		return this.#globalIdScopes;
	}

	get stats(): SectionIndexStats {
		const cache = this.store.cacheStats;
		return {
			cache,
			windowBytes: this.window.capacity,
			windowRefills: this.window.refills,
			residentBytes: cache.residentBytes + this.window.residentBytes,
		};
	}

	read(range: ByteRange): Uint8Array {
		return this.window.read(range.offset, range.length);
	}

	// -- Revisions ----------------------------------------------------------

	/** @internal Appends a revision and returns its order. */
	addRevision(revision: Omit<RevisionDescriptor, 'order' | 'rootObjectCount' | 'roleAssociationCount' | 'objectCount'>): number {
		const order = this.#revisionCount++;
		this.#writeRevision({
			...revision,
			order,
			rootObjectCount: 0,
			roleAssociationCount: 0,
			objectCount: 0,
		});
		this.store.set(
			this.key.reset(Tag.revisionByGuid).extendedGuid(revision.id).done(),
			this.value.reset().u32(order).done());
		return order;
	}

	/** @internal */
	hasRevision(id: IndexedGuid): boolean {
		return this.store.has(this.key.reset(Tag.revisionByGuid).extendedGuid(id).done());
	}

	/** @internal */
	addRootObject(revision: number, root: RootObjectDescriptor): void {
		const current = this.revisionAt(revision);
		this.store.set(
			this.key.reset(Tag.revisionRoot).u32(revision).u32(current.rootObjectCount).done(),
			this.value.reset().extendedGuid(root.objectId).u32(root.role).done());
		this.#writeRevision({ ...current, rootObjectCount: current.rootObjectCount + 1 });
	}

	/** @internal */
	addRoleAssociation(revision: number, association: RoleAssociationDescriptor): void {
		const current = this.revisionAt(revision);
		this.store.set(
			this.key.reset(Tag.revisionRole).u32(revision).u32(current.roleAssociationCount).done(),
			this.value.reset()
				.optionalExtendedGuid(association.contextId)
				.u32(association.role)
				.u32(association.order)
				.done());
		this.#writeRevision({ ...current, roleAssociationCount: current.roleAssociationCount + 1 });
	}

	/** @internal Records the object space a revision belongs to, once known. */
	setObjectSpace(revision: number, objectSpaceId: IndexedGuid | undefined, contextId?: IndexedGuid): void {
		this.#writeRevision({ ...this.revisionAt(revision), objectSpaceId, contextId });
	}

	revisionAt(order: number): RevisionDescriptor {
		const stored = this.store.get(this.key.reset(Tag.revisionByOrder).u32(order).done());
		if (!stored) throw outOfRange('Revision', order, this.#revisionCount);

		const reader = new RecordReader(stored);
		return {
			order,
			id: reader.extendedGuid(),
			dependencyId: reader.optionalExtendedGuid(),
			role: reader.u32(),
			isEncrypted: reader.flag(),
			contextId: reader.optionalExtendedGuid(),
			objectSpaceId: reader.optionalExtendedGuid(),
			rootObjectCount: reader.u32(),
			roleAssociationCount: reader.u32(),
			objectCount: reader.u32(),
		};
	}

	revision(id: IndexedGuid): RevisionDescriptor | undefined {
		const stored = this.store.get(this.key.reset(Tag.revisionByGuid).extendedGuid(id).done());
		return stored ? this.revisionAt(new RecordReader(stored).u32()) : undefined;
	}

	*revisions(): IterableIterator<RevisionDescriptor> {
		for (let order = 0; order < this.#revisionCount; order++) yield this.revisionAt(order);
	}

	*rootObjectsOf(revision: number): IterableIterator<RootObjectDescriptor> {
		const { rootObjectCount } = this.revisionAt(revision);
		for (let index = 0; index < rootObjectCount; index++) {
			const stored = this.store.get(this.key.reset(Tag.revisionRoot).u32(revision).u32(index).done())!;
			const reader = new RecordReader(stored);
			yield { objectId: reader.extendedGuid(), role: reader.u32() };
		}
	}

	*roleAssociationsOf(revision: number): IterableIterator<RoleAssociationDescriptor> {
		const { roleAssociationCount } = this.revisionAt(revision);
		for (let index = 0; index < roleAssociationCount; index++) {
			const stored = this.store.get(this.key.reset(Tag.revisionRole).u32(revision).u32(index).done())!;
			const reader = new RecordReader(stored);
			yield { contextId: reader.optionalExtendedGuid(), role: reader.u32(), order: reader.u32() };
		}
	}

	*objectsOf(revision: number): IterableIterator<ObjectDescriptor> {
		const { objectCount } = this.revisionAt(revision);
		for (let index = 0; index < objectCount; index++) {
			const stored = this.store.get(this.key.reset(Tag.revisionObject).u32(revision).u32(index).done())!;
			yield this.objectAt(new RecordReader(stored).u32());
		}
	}

	#writeRevision(revision: RevisionDescriptor): void {
		this.store.set(
			this.key.reset(Tag.revisionByOrder).u32(revision.order).done(),
			this.value.reset()
				.extendedGuid(revision.id)
				.optionalExtendedGuid(revision.dependencyId)
				.u32(revision.role)
				.flag(revision.isEncrypted)
				.optionalExtendedGuid(revision.contextId)
				.optionalExtendedGuid(revision.objectSpaceId)
				.u32(revision.rootObjectCount)
				.u32(revision.roleAssociationCount)
				.u32(revision.objectCount)
				.done());
	}

	// -- Objects ------------------------------------------------------------

	/** @internal Appends an object and returns its order. */
	addObject(object: Omit<ObjectDescriptor, 'order'>): number {
		if (this.#objectCount >= this.options.maxObjects) {
			throw new OneNoteFormatError(
				'ONENOTE_OBJECT_LIMIT',
				'The object declaration limit was exceeded.',
				object.propertySet?.offset);
		}

		const order = this.#objectCount++;
		this.updateObject({ ...object, order });
		this.store.set(
			this.key.reset(Tag.objectByGuid).extendedGuid(object.id).done(),
			this.value.reset().u32(order).done());

		if (object.revisionOrder >= 0) {
			const revision = this.revisionAt(object.revisionOrder);
			this.store.set(
				this.key.reset(Tag.revisionObject).u32(revision.order).u32(revision.objectCount).done(),
				this.value.reset().u32(order).done());
			this.#writeRevision({ ...revision, objectCount: revision.objectCount + 1 });
		}

		return order;
	}

	/** @internal Rewrites an object in place, for a partition seen later. */
	updateObject(object: ObjectDescriptor): void {
		this.store.set(
			this.key.reset(Tag.objectByOrder).u32(object.order).done(),
			this.value.reset()
				.extendedGuid(object.id)
				.u32(object.jcid)
				.u32(object.referenceCount)
				.i32(object.revisionOrder)
				.optionalExtendedGuid(object.revisionId)
				.flag(object.isRevision)
				.optionalRange(object.propertySet)
				.i32(object.globalIdScope ?? -1)
				.optionalText(object.fileDataReference)
				.optionalText(object.fileExtension)
				.optionalRange(object.objectReferences)
				.u32(object.objectReferenceCount ?? 0)
				.optionalRange(object.cellReferences)
				.u32(object.cellReferenceCount ?? 0)
				.optionalExtendedGuid(object.blobId)
				.done());
	}

	objectAt(order: number): ObjectDescriptor {
		const stored = this.store.get(this.key.reset(Tag.objectByOrder).u32(order).done());
		if (!stored) throw outOfRange('Object', order, this.#objectCount);

		const reader = new RecordReader(stored);
		const object: ObjectDescriptor = {
			order,
			id: reader.extendedGuid(),
			jcid: reader.u32(),
			referenceCount: reader.u32(),
			revisionOrder: reader.i32(),
			revisionId: reader.optionalExtendedGuid(),
			isRevision: reader.flag(),
			propertySet: reader.optionalRange(),
		};

		const scope = reader.i32();
		if (scope >= 0) object.globalIdScope = scope;
		object.fileDataReference = reader.optionalText();
		object.fileExtension = reader.optionalText();

		const objectReferences = reader.optionalRange();
		const objectReferenceCount = reader.u32();
		if (objectReferences) {
			object.objectReferences = objectReferences;
			object.objectReferenceCount = objectReferenceCount;
		}

		const cellReferences = reader.optionalRange();
		const cellReferenceCount = reader.u32();
		if (cellReferences) {
			object.cellReferences = cellReferences;
			object.cellReferenceCount = cellReferenceCount;
		}

		object.blobId = reader.optionalExtendedGuid();
		return object;
	}

	/**
	 * The object an identifier names.
	 *
	 * An identifier can be declared in more than one revision — the packaged
	 * encoding carries an unchanged object forward, and the desktop encoding
	 * revises one in place. This answers with the last declaration indexed,
	 * which is the current one; earlier ones are reached through their revision.
	 */
	object(id: IndexedGuid): ObjectDescriptor | undefined {
		const stored = this.store.get(this.key.reset(Tag.objectByGuid).extendedGuid(id).done());
		return stored ? this.objectAt(new RecordReader(stored).u32()) : undefined;
	}

	*objects(): IterableIterator<ObjectDescriptor> {
		for (let order = 0; order < this.#objectCount; order++) yield this.objectAt(order);
	}

	// -- File data ----------------------------------------------------------

	/** @internal */
	addFileData(key: string, payload: ByteRange): number {
		const order = this.#fileDataCount++;
		this.store.set(
			this.key.reset(Tag.fileDataByOrder).u32(order).done(),
			this.value.reset().text(key).range(payload).done());
		this.store.set(
			this.key.reset(Tag.fileDataByKey).text(key).done(),
			this.value.reset().u32(order).done());
		return order;
	}

	fileDataAt(order: number): FileDataDescriptor {
		const stored = this.store.get(this.key.reset(Tag.fileDataByOrder).u32(order).done());
		if (!stored) throw outOfRange('File data', order, this.#fileDataCount);

		const reader = new RecordReader(stored);
		return { order, key: reader.text(), payload: reader.range() };
	}

	fileData(key: string): FileDataDescriptor | undefined {
		const stored = this.store.get(this.key.reset(Tag.fileDataByKey).text(key).done());
		return stored ? this.fileDataAt(new RecordReader(stored).u32()) : undefined;
	}

	*fileDataObjects(): IterableIterator<FileDataDescriptor> {
		for (let order = 0; order < this.#fileDataCount; order++) yield this.fileDataAt(order);
	}

	// -- Global identification ----------------------------------------------

	/**
	 * @internal Opens a scope.
	 *
	 * A desktop global-identification table is cleared and refilled as the walk
	 * moves between file-node lists, and a CompactID means whatever the table
	 * said at the moment its object was declared. Clearing therefore cannot
	 * mean deleting: an object indexed earlier still refers to the old entries.
	 * Each clear opens a new scope instead, and an object records which one it
	 * was declared under.
	 */
	openGlobalIdScope(): number {
		return this.#globalIdScopes++;
	}

	/** @internal */
	addGlobalId(scope: number, index: number, identifier: string): void {
		this.store.set(
			this.key.reset(Tag.globalId).u32(scope).u32(index).done(),
			this.value.reset().guid(identifier).done());
	}

	/** @internal */
	hasGlobalId(scope: number, index: number): boolean {
		return this.store.has(this.key.reset(Tag.globalId).u32(scope).u32(index).done());
	}

	globalId(scope: number, index: number): string | undefined {
		const stored = this.store.get(this.key.reset(Tag.globalId).u32(scope).u32(index).done());
		return stored ? new RecordReader(stored).guid() : undefined;
	}

	/**
	 * A scope's global-identification table, as `readPropertySet` expects it.
	 *
	 * That reader wants a `Map`, and the whole point of the index is that this
	 * table is not one — it is on disk, and a table with a hundred thousand
	 * entries must not become a hundred thousand heap entries just to decode one
	 * object. So this is a `Map` that answers from the store instead of from
	 * itself, which is all the reader ever asks of it.
	 */
	globalIdTable(scope: number): Map<number, string> {
		return new GlobalIdTable(this, scope);
	}

	close(): void {
		this.store.close();
	}
}

class GlobalIdTable extends Map<number, string> {
	readonly #index: IndexedSection;
	readonly #scope: number;

	constructor(index: IndexedSection, scope: number) {
		super();
		this.#index = index;
		this.#scope = scope;
	}

	override get(index: number): string | undefined {
		return this.#index.globalId(this.#scope, index);
	}

	override has(index: number): boolean {
		return this.#index.hasGlobalId(this.#scope, index);
	}
}
