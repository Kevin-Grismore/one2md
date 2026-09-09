/**
 * Indexing a packaged MS-FSSHTTPB section without building it.
 *
 * `readDataElementPackage` builds two things that are both proportional to the
 * section: a `WalkNode` tree with one node per stream object — and a packaged
 * section is nothing but stream objects — and a `DataElementPackage` of maps
 * holding every manifest, every object group's declarations and data, and every
 * blob's bytes. `buildObjectGraph` then walks that into a third structure with a
 * decoded property set per object.
 *
 * This reads the same package from the event walker, one stream object at a
 * time, and writes fixed-size descriptors to the on-disk index. The heap holds
 * the walker's stack of open types, one declaration or data record at a time,
 * and a handful of counters. An object's property set, an object's reference
 * arrays and a blob's payload are all recorded as ranges: none of those bytes
 * are read here, and the four bytes of a JCID are the only object content this
 * pass looks at.
 *
 * Two structures do have to be reassembled, for the reason `object-graph.ts`
 * gives: a packaged object is split across partitions of an object group, so
 * its type code and its property set arrive separately and mean nothing apart.
 * Merging them is done through the store, keyed by revision and object, so the
 * merge costs disk rather than a map that grows with the object count.
 *
 * What is deliberately left undone is the cell chain — which cell a revision
 * belongs to, and therefore its object space, role and context. That is a
 * question about the semantic layer's view of the section, it needs no bytes
 * beyond what is indexed here, and the storage index and cell manifests are
 * exposed so the next stage can answer it lazily.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { FileHeader } from '../onenote-file/onestore/file-header';
import { DataElementType, DATA_ELEMENT_TYPE } from '../fsshttpb/data-element';
import { isNullExtendedGuid } from '../fsshttpb/binary';
import { CountedRange, SourceCursor } from '../fsshttpb/source-cursor';
import { StreamObjectEvent, walkStreamObjects } from '../fsshttpb/stream-walk';
import { Partition, StreamObject } from '../fsshttpb/types';
import { ByteRange } from '../storage/byte-source';
import { ByteWindow } from '../storage/byte-window';
import { RecordReader } from '../storage/records';
import {
	IndexedGuid,
	IndexedSection,
	INDEXER_TAG_BASE,
	indexedGuidKey,
	ObjectDescriptor,
	SectionIndexOptions,
} from './section-index';

export interface SerialNumber {
	identifier: string;
	value: number;
}

export interface IndexedCellId {
	first: IndexedGuid;
	second: IndexedGuid;
}

export interface ManifestMappingDescriptor {
	id: IndexedGuid;
	serial: SerialNumber;
}

export interface CellMappingDescriptor {
	cell: IndexedCellId;
	id: IndexedGuid;
	serial: SerialNumber;
}

export interface RevisionMappingDescriptor {
	revision: IndexedGuid;
	id: IndexedGuid;
	serial: SerialNumber;
}

export interface ManifestRootDescriptor {
	root: IndexedGuid;
	cell: IndexedCellId;
}

export interface ObjectGroupDescriptor {
	order: number;
	/** The data element that holds the group. */
	id: IndexedGuid;
	declarationCount: number;
	dataCount: number;
}

export interface ObjectDeclarationDescriptor {
	object: IndexedGuid;
	/** Set only on a blob-reference declaration, which names its payload. */
	blob?: IndexedGuid;
	partition: number;
	/** Absent on a blob reference, which carries no inline data. */
	dataSize?: number;
	objectReferenceCount: number;
	cellReferenceCount: number;
}

export interface ObjectDataDescriptor {
	objectReferences: CountedRange;
	cellReferences: CountedRange;
	/** The object's own bytes, or absent when it is a blob reference. */
	data?: ByteRange;
	blob?: IndexedGuid;
}

const Tag = {
	manifestMapping: INDEXER_TAG_BASE,
	cellMapping: INDEXER_TAG_BASE + 1,
	revisionMapping: INDEXER_TAG_BASE + 2,
	manifestRoot: INDEXER_TAG_BASE + 3,
	cellManifest: INDEXER_TAG_BASE + 4,
	revisionOfElement: INDEXER_TAG_BASE + 5,
	revisionGroup: INDEXER_TAG_BASE + 6,
	objectGroupByOrder: INDEXER_TAG_BASE + 7,
	objectGroupByElement: INDEXER_TAG_BASE + 8,
	groupDeclaration: INDEXER_TAG_BASE + 9,
	groupData: INDEXER_TAG_BASE + 10,
	accumulated: INDEXER_TAG_BASE + 11,
	placed: INDEXER_TAG_BASE + 12,
} as const;

const EMPTY_VALUE = new Uint8Array(0);

function missing(what: string, type: number, event?: StreamObjectEvent): OneNoteFormatError {
	return new OneNoteFormatError('ONENOTE_FSSHTTPB_MISSING_STRUCTURE',
		`Expected ${what} (0x${type.toString(16)}) but found `
		+ (event ? `0x${event.type.toString(16)}` : 'nothing') + '.', event?.offset);
}

function expect(event: StreamObjectEvent, type: StreamObject, what: string): void {
	if (event.type !== type) throw missing(what, type, event);
}

/**
 * A packaged section's index: the shared descriptors, plus the storage index
 * and object-group tables that only this encoding has.
 */
export class PackageIndexedSection extends IndexedSection {
	/** The cell schema the storage manifest declares. */
	schema = '';

	manifestMappingCount = 0;
	cellMappingCount = 0;
	revisionMappingCount = 0;
	manifestRootCount = 0;
	objectGroupCount = 0;

	manifestMappingAt(position: number): ManifestMappingDescriptor {
		const reader = this.#at(Tag.manifestMapping, position, 'A manifest mapping');
		return { id: reader.extendedGuid(), serial: readSerial(reader) };
	}

	cellMappingAt(position: number): CellMappingDescriptor {
		const reader = this.#at(Tag.cellMapping, position, 'A cell mapping');
		return { cell: readCell(reader), id: reader.extendedGuid(), serial: readSerial(reader) };
	}

	revisionMappingAt(position: number): RevisionMappingDescriptor {
		const reader = this.#at(Tag.revisionMapping, position, 'A revision mapping');
		return { revision: reader.extendedGuid(), id: reader.extendedGuid(), serial: readSerial(reader) };
	}

	manifestRootAt(position: number): ManifestRootDescriptor {
		const reader = this.#at(Tag.manifestRoot, position, 'A storage manifest root');
		return { root: reader.extendedGuid(), cell: readCell(reader) };
	}

	*manifestMappings(): IterableIterator<ManifestMappingDescriptor> {
		for (let index = 0; index < this.manifestMappingCount; index++) yield this.manifestMappingAt(index);
	}

	*cellMappings(): IterableIterator<CellMappingDescriptor> {
		for (let index = 0; index < this.cellMappingCount; index++) yield this.cellMappingAt(index);
	}

	*revisionMappings(): IterableIterator<RevisionMappingDescriptor> {
		for (let index = 0; index < this.revisionMappingCount; index++) yield this.revisionMappingAt(index);
	}

	*manifestRoots(): IterableIterator<ManifestRootDescriptor> {
		for (let index = 0; index < this.manifestRootCount; index++) yield this.manifestRootAt(index);
	}

	/** The revision a cell manifest element declares current. */
	cellManifest(element: IndexedGuid): IndexedGuid | undefined {
		const stored = this.store.get(this.key.reset(Tag.cellManifest).extendedGuid(element).done());
		return stored ? new RecordReader(stored).extendedGuid() : undefined;
	}

	/** Which indexed revision a revision-manifest data element became. */
	revisionOfElement(element: IndexedGuid): number | undefined {
		const stored = this.store.get(this.key.reset(Tag.revisionOfElement).extendedGuid(element).done());
		return stored ? new RecordReader(stored).u32() : undefined;
	}

	/** The object-group elements a revision names, in declared order. */
	*objectGroupsOf(revision: number): IterableIterator<IndexedGuid> {
		const count = this.#counter(Tag.revisionGroup, revision);
		for (let index = 0; index < count; index++) {
			const stored = this.store.get(this.key.reset(Tag.revisionGroup).u32(revision).u32(index).done())!;
			yield new RecordReader(stored).extendedGuid();
		}
	}

	objectGroupCountOf(revision: number): number {
		return this.#counter(Tag.revisionGroup, revision);
	}

	objectGroupAt(order: number): ObjectGroupDescriptor {
		const stored = this.store.get(this.key.reset(Tag.objectGroupByOrder).u32(order).done());
		if (!stored) {
			throw new OneNoteFormatError('ONENOTE_INDEX_OUT_OF_RANGE',
				`Object group ${order} was asked for, but the index holds ${this.objectGroupCount}.`);
		}

		const reader = new RecordReader(stored);
		return { order, id: reader.extendedGuid(), declarationCount: reader.u32(), dataCount: reader.u32() };
	}

	objectGroup(element: IndexedGuid): ObjectGroupDescriptor | undefined {
		const stored = this.store.get(this.key.reset(Tag.objectGroupByElement).extendedGuid(element).done());
		return stored ? this.objectGroupAt(new RecordReader(stored).u32()) : undefined;
	}

	*objectGroups(): IterableIterator<ObjectGroupDescriptor> {
		for (let order = 0; order < this.objectGroupCount; order++) yield this.objectGroupAt(order);
	}

	declarationAt(group: number, position: number): ObjectDeclarationDescriptor {
		const stored = this.store.get(this.key.reset(Tag.groupDeclaration).u32(group).u32(position).done());
		if (!stored) {
			throw new OneNoteFormatError('ONENOTE_INDEX_OUT_OF_RANGE',
				`Declaration ${position} of object group ${group} is not in the index.`);
		}

		const reader = new RecordReader(stored);
		return {
			object: reader.extendedGuid(),
			blob: reader.optionalExtendedGuid(),
			partition: reader.big(),
			dataSize: reader.optionalBig(),
			objectReferenceCount: reader.big(),
			cellReferenceCount: reader.big(),
		};
	}

	objectDataAt(group: number, position: number): ObjectDataDescriptor {
		const stored = this.store.get(this.key.reset(Tag.groupData).u32(group).u32(position).done());
		if (!stored) {
			throw new OneNoteFormatError('ONENOTE_INDEX_OUT_OF_RANGE',
				`Object data ${position} of object group ${group} is not in the index.`);
		}

		const reader = new RecordReader(stored);
		return {
			objectReferences: { count: reader.big(), range: reader.range() },
			cellReferences: { count: reader.big(), range: reader.range() },
			data: reader.optionalRange(),
			blob: reader.optionalExtendedGuid(),
		};
	}

	/**
	 * [MS-FSSHTTPB] 2.2.1.8 — a counted Extended GUID array, decoded on demand.
	 *
	 * The packaged encoding has no global-identification table: an object's
	 * CompactIDs are resolved against its own reference arrays, positionally.
	 * Those are what the next stage pairs with the CompactIDs in the property
	 * set, and pass `ObjectDescriptor.objectReferences` to read them — the
	 * array is decoded from the file now rather than held since indexing.
	 */
	*extendedGuidsIn(range: ByteRange | undefined): IterableIterator<IndexedGuid> {
		if (!range) return;
		const cursor = this.#cursorOver(range);
		const count = cursor.readCompactUint();
		for (let index = 0; index < count; index++) yield cursor.readExtendedGuid();
	}

	/** [MS-FSSHTTPB] 2.2.1.11 — the cell-identifier array beside it. */
	*cellIdsIn(range: ByteRange | undefined): IterableIterator<IndexedCellId> {
		if (!range) return;
		const cursor = this.#cursorOver(range);
		const count = cursor.readCompactUint();
		for (let index = 0; index < count; index++) yield cursor.readCellId();
	}

	#cursorOver(range: ByteRange): SourceCursor {
		return new SourceCursor(this.window, range.offset, range.offset + range.length);
	}

	/** @internal */
	bumpCounter(tag: number, scope: number): number {
		const next = this.#counter(tag, scope);
		this.store.set(
			this.key.reset(tag).u32(scope).done(),
			this.value.reset().u32(next + 1).done());
		return next;
	}

	#counter(tag: number, scope: number): number {
		const stored = this.store.get(this.key.reset(tag).u32(scope).done());
		return stored ? new RecordReader(stored).u32() : 0;
	}

	#at(tag: number, position: number, what: string): RecordReader {
		const stored = this.store.get(this.key.reset(tag).u32(position).done());
		if (!stored) {
			throw new OneNoteFormatError('ONENOTE_INDEX_OUT_OF_RANGE', `${what} ${position} is not in the index.`);
		}
		return new RecordReader(stored);
	}
}

function readSerial(reader: RecordReader): SerialNumber {
	return { identifier: reader.guid(), value: reader.big() };
}

function readCell(reader: RecordReader): IndexedCellId {
	return { first: reader.extendedGuid(), second: reader.extendedGuid() };
}

interface ElementContext {
	id: IndexedGuid;
	type: DataElementType;
	childIndex: number;
	/** Object groups only: which indexed group this element became. */
	group: number;
	/** Revision manifests only: which indexed revision this element became. */
	revision: number;
}

class PackageIndexer {
	readonly #index: PackageIndexedSection;
	readonly #window: ByteWindow;

	#sawPackage = false;
	#inPackage = false;
	#sawStorageIndex = false;
	#sawStorageManifest = false;

	#element?: ElementContext;
	#section?: number;

	constructor(index: PackageIndexedSection) {
		this.#index = index;
		this.#window = index.window;
	}

	run(): void {
		for (const event of walkStreamObjects(this.#window)) {
			if (event.kind === 'end') this.#end(event);
			else this.#start(event);
		}

		if (!this.#sawStorageIndex) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_NO_STORAGE_INDEX',
				'The data element package has no storage index.');
		}
		if (!this.#sawStorageManifest) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_NO_STORAGE_MANIFEST',
				'The data element package has no storage manifest.');
		}

		this.#accumulateObjects();
	}

	// -- The event state machine --------------------------------------------

	#start(event: StreamObjectEvent): void {
		switch (event.depth) {
			case 0:
				// The packaging object. Its type and its own data — the storage
				// index identifier and the cell schema — are checked by
				// `readFileHeader` before an index is ever started.
				break;

			case 1:
				// Only the first child is the package; `readDataElementPackage`
				// ignores anything after it, and so does this.
				if (this.#sawPackage) break;
				this.#sawPackage = true;
				expect(event, StreamObject.DataElementPackage, 'a data element package');
				this.#inPackage = true;
				break;

			case 2:
				if (this.#inPackage) this.#beginElement(event);
				break;

			case 3:
				if (this.#element) this.#elementChild(event);
				break;

			case 4:
				if (this.#element && this.#section !== undefined) this.#sectionChild(event);
				break;

			default:
				break;
		}
	}

	#end(event: StreamObjectEvent): void {
		if (event.depth === 1) this.#inPackage = false;
		else if (event.depth === 2 && this.#element) this.#finishElement();
		else if (event.depth === 3) this.#section = undefined;
	}

	/** [MS-FSSHTTPB] 2.2.1.12.2 — one data element's identity. */
	#beginElement(event: StreamObjectEvent): void {
		if (event.type !== DATA_ELEMENT_TYPE) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_NOT_DATA_ELEMENT',
				`Stream object type 0x${event.type.toString(16)} is not a data element.`, event.offset);
		}

		const cursor = new SourceCursor(this.#window, event.dataOffset, event.dataOffset + event.dataLength);
		const id = cursor.readExtendedGuid();
		cursor.readSerialNumber();
		const type = cursor.readCompactUint();

		if (!cursor.atEnd) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_DATA_ELEMENT_LENGTH',
				`A data element declares ${event.dataLength} bytes but its header uses `
				+ `${cursor.position - event.dataOffset}.`, event.dataOffset);
		}
		if (!(type in DataElementType)) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_DATA_ELEMENT_TYPE',
				`Data element type ${type} is not one this reader knows.`, event.dataOffset);
		}

		this.#element = { id, type, childIndex: 0, group: -1, revision: -1 };

		if (type === DataElementType.StorageIndex) this.#sawStorageIndex = true;
		if (type === DataElementType.StorageManifest) this.#sawStorageManifest = true;

		if (type === DataElementType.ObjectGroup) {
			const order = this.#index.objectGroupCount++;
			this.#element.group = order;
			this.#index.store.set(
				this.#index.key.reset(Tag.objectGroupByElement).extendedGuid(id).done(),
				this.#index.value.reset().u32(order).done());
			this.#writeObjectGroup(order, id, 0, 0);
		}

		// An element with no children never produces an end event.
		if (!event.compound) this.#finishElement();
	}

	#finishElement(): void {
		const element = this.#element!;
		this.#element = undefined;
		this.#section = undefined;

		if (element.childIndex > 0) return;

		// `readDataElementPackage` reaches for `children.at(0)` on these four
		// and reports a missing structure when it is not there.
		switch (element.type) {
			case DataElementType.StorageManifest:
				throw missing('a schema GUID', StreamObject.StorageManifestSchemaGuid);
			case DataElementType.CellManifest:
				throw missing('a current revision', StreamObject.CellManifestCurrentRevision);
			case DataElementType.RevisionManifest:
				throw missing('a revision manifest', StreamObject.RevisionManifest);
			case DataElementType.ObjectDataBlob:
				throw missing('a BLOB payload', StreamObject.ObjectDataBlob);
			default:
				break;
		}
	}

	#elementChild(event: StreamObjectEvent): void {
		const element = this.#element!;

		switch (element.type) {
			case DataElementType.StorageIndex:
				this.#readStorageIndexMapping(event);
				break;
			case DataElementType.StorageManifest:
				this.#readStorageManifestChild(event, element);
				break;
			case DataElementType.CellManifest:
				if (element.childIndex === 0) {
					expect(event, StreamObject.CellManifestCurrentRevision, 'a current revision');
					const revision = this.#exact(event, cursor => cursor.readExtendedGuid());
					this.#index.store.set(
						this.#index.key.reset(Tag.cellManifest).extendedGuid(element.id).done(),
						this.#index.value.reset().extendedGuid(revision).done());
				}
				break;
			case DataElementType.RevisionManifest:
				this.#readRevisionManifestChild(event, element);
				break;
			case DataElementType.ObjectGroup:
				if (event.type !== StreamObject.ObjectGroupDeclarations && event.type !== StreamObject.ObjectGroupData) {
					throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MISSING_STRUCTURE',
						`An object group cannot hold a 0x${event.type.toString(16)}.`, event.offset);
				}
				this.#section = event.type;
				break;
			case DataElementType.ObjectDataBlob:
				if (element.childIndex === 0) {
					expect(event, StreamObject.ObjectDataBlob, 'a BLOB payload');
					this.#index.addFileData(indexedGuidKey(element.id), {
						offset: event.dataOffset,
						length: event.dataLength,
					});
				}
				break;
			default:
				// A fragment reassembles an element split across responses,
				// which a file on disk never is.
				break;
		}

		element.childIndex++;
	}

	#readStorageIndexMapping(event: StreamObjectEvent): void {
		const index = this.#index;

		switch (event.type) {
			case StreamObject.StorageIndexManifestMapping: {
				const mapping = this.#exact(event, cursor => ({
					id: cursor.readExtendedGuid(),
					serial: cursor.readSerialNumber(),
				}));
				index.store.set(
					index.key.reset(Tag.manifestMapping).u32(index.manifestMappingCount++).done(),
					index.value.reset().extendedGuid(mapping.id).guid(mapping.serial.identifier).big(mapping.serial.value).done());
				break;
			}
			case StreamObject.StorageIndexCellMapping: {
				const mapping = this.#exact(event, cursor => ({
					cell: cursor.readCellId(),
					id: cursor.readExtendedGuid(),
					serial: cursor.readSerialNumber(),
				}));
				index.store.set(
					index.key.reset(Tag.cellMapping).u32(index.cellMappingCount++).done(),
					index.value.reset()
						.extendedGuid(mapping.cell.first)
						.extendedGuid(mapping.cell.second)
						.extendedGuid(mapping.id)
						.guid(mapping.serial.identifier)
						.big(mapping.serial.value)
						.done());
				break;
			}
			case StreamObject.StorageIndexRevisionMapping: {
				const mapping = this.#exact(event, cursor => ({
					revision: cursor.readExtendedGuid(),
					id: cursor.readExtendedGuid(),
					serial: cursor.readSerialNumber(),
				}));
				index.store.set(
					index.key.reset(Tag.revisionMapping).u32(index.revisionMappingCount++).done(),
					index.value.reset()
						.extendedGuid(mapping.revision)
						.extendedGuid(mapping.id)
						.guid(mapping.serial.identifier)
						.big(mapping.serial.value)
						.done());
				break;
			}
			default:
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MISSING_STRUCTURE',
					`A storage index cannot hold a 0x${event.type.toString(16)}.`, event.offset);
		}
	}

	#readStorageManifestChild(event: StreamObjectEvent, element: ElementContext): void {
		if (element.childIndex === 0) {
			expect(event, StreamObject.StorageManifestSchemaGuid, 'a schema GUID');
			this.#index.schema = this.#exact(event, cursor => cursor.readGuid());
			return;
		}

		expect(event, StreamObject.StorageManifestRootDeclare, 'a root declaration');
		const root = this.#exact(event, cursor => ({
			root: cursor.readExtendedGuid(),
			cell: cursor.readCellId(),
		}));

		this.#index.store.set(
			this.#index.key.reset(Tag.manifestRoot).u32(this.#index.manifestRootCount++).done(),
			this.#index.value.reset()
				.extendedGuid(root.root)
				.extendedGuid(root.cell.first)
				.extendedGuid(root.cell.second)
				.done());
	}

	#readRevisionManifestChild(event: StreamObjectEvent, element: ElementContext): void {
		const index = this.#index;

		if (element.childIndex === 0) {
			expect(event, StreamObject.RevisionManifest, 'a revision manifest');
			const head = this.#exact(event, cursor => ({
				revision: cursor.readExtendedGuid(),
				baseRevision: cursor.readExtendedGuid(),
			}));

			element.revision = index.addRevision({
				id: head.revision,
				dependencyId: isNullExtendedGuid(head.baseRevision) ? undefined : head.baseRevision,
				// A packaged revision carries neither: its role comes from being
				// a cell's current revision, and the encoding has no encrypted
				// form. The next stage assigns both from the cell chain.
				role: 0,
				isEncrypted: false,
			});

			index.store.set(
				index.key.reset(Tag.revisionOfElement).extendedGuid(element.id).done(),
				index.value.reset().u32(element.revision).done());
			return;
		}

		switch (event.type) {
			case StreamObject.RevisionManifestRootDeclare: {
				const declared = this.#exact(event, cursor => ({
					root: cursor.readExtendedGuid(),
					object: cursor.readExtendedGuid(),
				}));
				index.addRootObject(element.revision, { objectId: declared.object, role: declared.root.value });
				break;
			}
			case StreamObject.RevisionManifestObjectGroupReference: {
				const group = this.#exact(event, cursor => cursor.readExtendedGuid());
				const position = index.bumpCounter(Tag.revisionGroup, element.revision);
				index.store.set(
					index.key.reset(Tag.revisionGroup).u32(element.revision).u32(position).done(),
					index.value.reset().extendedGuid(group).done());
				break;
			}
			default:
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MISSING_STRUCTURE',
					`A revision manifest cannot hold a 0x${event.type.toString(16)}.`, event.offset);
		}
	}

	#sectionChild(event: StreamObjectEvent): void {
		const element = this.#element!;
		const index = this.#index;
		const group = index.objectGroupAt(element.group);

		if (this.#section === StreamObject.ObjectGroupDeclarations) {
			const isBlobReference = event.type === StreamObject.ObjectGroupObjectDeclareBlobReference;
			if (!isBlobReference) expect(event, StreamObject.ObjectGroupObjectDeclare, 'an object declaration');

			const declaration = this.#exact(event, cursor => ({
				object: cursor.readExtendedGuid(),
				// A blob reference names its payload element instead of
				// carrying a size, so the two forms differ by one field each.
				blob: isBlobReference ? cursor.readExtendedGuid() : undefined,
				partition: cursor.readCompactUint(),
				dataSize: isBlobReference ? undefined : cursor.readCompactUint(),
				objectReferenceCount: cursor.readCompactUint(),
				cellReferenceCount: cursor.readCompactUint(),
			}));

			index.store.set(
				index.key.reset(Tag.groupDeclaration).u32(group.order).u32(group.declarationCount).done(),
				index.value.reset()
					.extendedGuid(declaration.object)
					.optionalExtendedGuid(declaration.blob)
					.big(declaration.partition)
					.optionalBig(declaration.dataSize)
					.big(declaration.objectReferenceCount)
					.big(declaration.cellReferenceCount)
					.done());
			this.#writeObjectGroup(group.order, group.id, group.declarationCount + 1, group.dataCount);
			return;
		}

		const isBlobReference = event.type === StreamObject.ObjectGroupObjectDataBlobReference;
		if (!isBlobReference) expect(event, StreamObject.ObjectGroupObjectData, 'object data');

		const data = this.#exact(event, cursor => {
			// The object's identity is not repeated here; it comes from the
			// declaration at the same position.
			const objectReferences = cursor.skipExtendedGuidArray();
			const cellReferences = cursor.skipCellIdArray();
			return {
				objectReferences,
				cellReferences,
				payload: isBlobReference ? undefined : cursor.readBinaryItemRange(),
				blob: isBlobReference ? cursor.readExtendedGuid() : undefined,
			};
		});

		index.store.set(
			index.key.reset(Tag.groupData).u32(group.order).u32(group.dataCount).done(),
			index.value.reset()
				.big(data.objectReferences.count)
				.range(data.objectReferences.range)
				.big(data.cellReferences.count)
				.range(data.cellReferences.range)
				.optionalRange(data.payload)
				.optionalExtendedGuid(data.blob)
				.done());
		this.#writeObjectGroup(group.order, group.id, group.declarationCount, group.dataCount + 1);
	}

	#writeObjectGroup(order: number, id: IndexedGuid, declarationCount: number, dataCount: number): void {
		this.#index.store.set(
			this.#index.key.reset(Tag.objectGroupByOrder).u32(order).done(),
			this.#index.value.reset().extendedGuid(id).u32(declarationCount).u32(dataCount).done());
	}

	/**
	 * Read one stream object's data, insisting the fields consume all of it.
	 *
	 * The same contract `readExact` enforces, for the same reason: the format
	 * has no padding to hide a mistake in, so stopping short means a field was
	 * read too narrow and running over means too wide.
	 */
	#exact<T>(event: StreamObjectEvent, read: (cursor: SourceCursor) => T): T {
		const cursor = new SourceCursor(this.#window, event.dataOffset, event.dataOffset + event.dataLength);
		const value = read(cursor);

		if (!cursor.atEnd) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_STRUCTURE_LENGTH',
				`Stream object 0x${event.type.toString(16)} declares ${event.dataLength} bytes `
				+ `but its fields used ${cursor.position - event.dataOffset}.`, event.dataOffset);
		}

		return value;
	}

	// -- Reassembling objects from partitions -------------------------------

	/**
	 * Merge each revision's object groups into whole objects.
	 *
	 * An object group is named by a revision but can sit anywhere in the
	 * package, so this runs once the elements are all indexed. Both sides of it
	 * are on disk: the declarations and data are read back by range, and the
	 * partial object being built is the index record itself, rewritten as each
	 * partition arrives.
	 */
	#accumulateObjects(): void {
		const index = this.#index;

		for (let revision = 0; revision < index.revisionCount; revision++) {
			for (const groupId of index.objectGroupsOf(revision)) {
				const group = index.objectGroup(groupId);
				if (!group) continue;

				for (let position = 0; position < group.declarationCount; position++) {
					// Declarations and data pair up by position; a declaration
					// with no data beside it describes nothing.
					if (position >= group.dataCount) continue;
					this.#merge(revision, index.declarationAt(group.order, position), index.objectDataAt(group.order, position));
				}
			}
		}
	}

	#merge(revision: number, declaration: ObjectDeclarationDescriptor, data: ObjectDataDescriptor): void {
		const index = this.#index;
		const object = this.#objectFor(revision, declaration.object);

		object.referenceCount = Math.max(
			object.referenceCount,
			declaration.objectReferenceCount + declaration.cellReferenceCount);

		switch (declaration.partition) {
			case Partition.ObjectMetadata: {
				if (data.data?.length !== 4) {
					throw new OneNoteFormatError('ONENOTE_FSSHTTPB_JCID',
						'Object metadata is not a four-byte type code.', data.data?.offset);
				}
				const bytes = this.#window.peek(data.data.offset, 4);
				object.jcid = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
				break;
			}
			case Partition.ObjectData:
				object.propertySet = data.data;
				object.objectReferences = data.objectReferences.range;
				object.objectReferenceCount = data.objectReferences.count;
				object.cellReferences = data.cellReferences.range;
				object.cellReferenceCount = data.cellReferences.count;
				break;
			case Partition.ObjectFileData:
				object.blobId = data.blob ?? declaration.blob;
				break;
			default:
				// An unknown partition carries something no reader here has a
				// use for. Skipping it loses nothing.
				break;
		}

		index.updateObject(object);
	}

	/** The object being assembled for this identity in this revision. */
	#objectFor(revision: number, id: IndexedGuid): ObjectDescriptor {
		const index = this.#index;
		const existing = index.store.get(index.key.reset(Tag.accumulated).u32(revision).extendedGuid(id).done());
		if (existing) return index.objectAt(new RecordReader(existing).u32());

		// An identity already seen in an earlier revision is that revision's,
		// carried forward rather than declared afresh.
		const placedKey = index.key.reset(Tag.placed).extendedGuid(id).done();
		const isRevision = index.store.has(placedKey);
		index.store.set(placedKey, EMPTY_VALUE);

		const order = index.addObject({
			id,
			jcid: 0,
			referenceCount: 0,
			revisionOrder: revision,
			revisionId: index.revisionAt(revision).id,
			isRevision,
		});

		index.store.set(
			index.key.reset(Tag.accumulated).u32(revision).extendedGuid(id).done(),
			index.value.reset().u32(order).done());

		return index.objectAt(order);
	}
}

export function indexPackage(
	header: FileHeader,
	window: ByteWindow,
	options: SectionIndexOptions = {},
): PackageIndexedSection {
	const index = new PackageIndexedSection('file-synchronization-package', header, window, options);

	try {
		new PackageIndexer(index).run();
	}
	catch (error) {
		index.close();
		throw error;
	}

	return index;
}
