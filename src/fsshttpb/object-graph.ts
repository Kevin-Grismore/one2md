/**
 * The adapter: an FSSHTTPB package, expressed as the object graph the existing
 * semantic layer already understands.
 *
 * This is the whole point of the exercise. `mapSection` and everything above it
 * read only `store.graph` — its revisions, objects and file-data objects — so a
 * packaged section that can be expressed in those three arrays converts through
 * exactly the same code as a desktop one, with no second implementation of
 * pages, outlines, tables or ink.
 *
 * Two things have to be reconstructed, because the packaged form scatters what
 * the desktop form keeps together:
 *
 *   - An object is split across partitions of an object group: a four-byte type
 *     code in one, its serialized property set in another. Both must be
 *     reassembled under one identity before it means anything.
 *   - A property set refers to other objects by CompactID, a 24-bit index into
 *     a global table. The desktop format stores that table; the packaged form
 *     has none, and instead supplies the Extended GUIDs positionally in the
 *     object's own reference arrays. The table has to be rebuilt per object.
 *
 * Field order and partition semantics follow OfficeIMO (MIT); see NOTICE.md.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { ExtendedGuid as StoreExtendedGuid } from '../onenote-file/onestore/file-header';
import {
	FileDataStoreObject,
	ObjectGraph,
	RevisionManifest as StoreRevisionManifest,
	RevisionStoreObject,
	RoleAssociation,
	RootObjectReference,
	keyOf,
} from '../onenote-file/onestore/objects';
import { DEFAULT_READER_OPTIONS, ReaderOptions } from '../onenote-file/onestore/options';
import { readPropertySet } from '../onenote-file/onestore/property-set';
import { readString } from '../onenote-file/semantic/properties';
import { Property } from '../onenote-file/semantic/schema';
import { CellId, ExtendedGuid, extendedGuidKey, isNullExtendedGuid, NIL_GUID } from './binary';
import { DataElementPackage, ObjectData, ObjectGroup, readDataElementPackage } from './package';
import { Partition } from './types';

/**
 * The context every section shares. A cell naming it is the default context,
 * not a distinct one, and recording it as distinct would split one object space
 * into two that never resolve.
 */
const DEFAULT_CONTEXT_GUID = '84defab9-aaa3-4a0d-a3a8-520c77ac7073';

function isDefaultContext(id: ExtendedGuid): boolean {
	return isNullExtendedGuid(id)
		|| (id.identifier === DEFAULT_CONTEXT_GUID && id.value === 1);
}

/** The two Extended GUID shapes are structurally identical; this states it. */
function toStoreGuid(id: ExtendedGuid): StoreExtendedGuid {
	return { identifier: id.identifier, value: id.value } as StoreExtendedGuid;
}

interface Accumulated {
	id: ExtendedGuid;
	jcid: number;
	propertyData?: Uint8Array;
	objectReferences: ExtendedGuid[];
	cellReferences: CellId[];
	blob?: ExtendedGuid;
	referenceCount: number;
	offset: number;
}

interface WorkingRevision {
	manifest: StoreRevisionManifest;
	objectGroups: ExtendedGuid[];
	cell?: CellId;
}

/**
 * [MS-ONESTORE] 2.6.7 — the reference streams that open a property set.
 *
 * Read here only to recover the CompactIDs, so they can be paired with the
 * Extended GUIDs that give them meaning. The property set is then read again in
 * full by the vendored reader, with the resulting table.
 */
interface ReferenceStream {
	compactIds: number[];
	extendedStreamsPresent: boolean;
	osidStreamNotPresent: boolean;
}

function readReferenceStream(data: Uint8Array, position: number): { stream: ReferenceStream, next: number } {
	if (position + 4 > data.length) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_OBJECT_STREAM',
			'A property reference stream is truncated.', position);
	}

	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const header = view.getUint32(position, true);
	const count = header & 0x00ffffff;

	if ((header & 0x3f000000) !== 0 || position + 4 + count * 4 > data.length) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_OBJECT_STREAM',
			'A property reference stream is invalid or longer than the object data.', position);
	}

	const compactIds: number[] = [];
	for (let index = 0; index < count; index++) compactIds.push(view.getUint32(position + 4 + index * 4, true));

	return {
		stream: {
			compactIds,
			extendedStreamsPresent: (header & 0x40000000) !== 0,
			osidStreamNotPresent: (header & 0x80000000) !== 0,
		},
		next: position + 4 + count * 4,
	};
}

/**
 * Pair a stream of CompactIDs with the Extended GUIDs that resolve them.
 *
 * The two arrays are positional, and a CompactID's low byte repeats the
 * Extended GUID's ordinal — so a misalignment is detectable rather than silent,
 * and is treated as an error instead of a guess.
 */
function addMappings(
	into: Map<number, string>,
	compactIds: number[],
	extendedIds: ExtendedGuid[],
	offset: number,
	kind: string,
): void {
	if (compactIds.length !== extendedIds.length) {
		throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MAPPING_COUNT',
			`The ${kind} CompactID and Extended GUID arrays have different lengths.`, offset);
	}

	for (let index = 0; index < compactIds.length; index++) {
		const compact = compactIds[index];
		const extended = extendedIds[index];
		if (compact === 0 && isNullExtendedGuid(extended)) continue;

		const globalIndex = compact >>> 8;
		const ordinal = compact & 0xff;

		if (globalIndex >= 0xffffff || extended.identifier === NIL_GUID || extended.value !== ordinal) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MAPPING',
				`A ${kind} mapping pairs a CompactID with an incompatible Extended GUID.`, offset);
		}

		const existing = into.get(globalIndex);
		if (existing !== undefined && existing !== extended.identifier) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MAPPING',
				'One CompactID global index maps to two different GUIDs.', offset);
		}

		into.set(globalIndex, extended.identifier);
	}
}

/** Rebuild the global ID table one object needs to resolve its own references. */
function buildGlobalIds(item: Accumulated, cell: CellId): Map<number, string> {
	const data = item.propertyData!;
	const mappings = new Map<number, string>();

	const { stream: oids, next } = readReferenceStream(data, 0);
	let osids: ReferenceStream | undefined;
	let contexts: ReferenceStream | undefined;

	if (!oids.osidStreamNotPresent) {
		const read = readReferenceStream(data, next);
		osids = read.stream;
		if (osids.extendedStreamsPresent) contexts = readReferenceStream(data, read.next).stream;
	}

	// A cell reference in the object's own space names an object space; one in
	// another space names a context. The current cell is what separates them.
	const osidReferences = item.cellReferences
		.filter(reference => extendedGuidKey(reference.first) === extendedGuidKey(cell.first))
		.map(reference => reference.second);
	const contextReferences = item.cellReferences
		.filter(reference => extendedGuidKey(reference.first) !== extendedGuidKey(cell.first))
		.map(reference => reference.first);

	addMappings(mappings, oids.compactIds, item.objectReferences, item.offset, 'object');
	if (osids) addMappings(mappings, osids.compactIds, osidReferences, item.offset, 'object-space');
	if (contexts) addMappings(mappings, contexts.compactIds, contextReferences, item.offset, 'context');

	return mappings;
}

/** Gather one object group's partitions into whole objects, in declared order. */
function accumulate(group: ObjectGroup, into: Map<string, Accumulated>, order: Accumulated[]): void {
	for (let index = 0; index < group.declarations.length; index++) {
		const declaration = group.declarations[index];
		const data: ObjectData | undefined = group.data[index];
		if (!data) continue;

		const key = extendedGuidKey(declaration.object);
		let item = into.get(key);
		if (!item) {
			item = {
				id: declaration.object,
				jcid: 0,
				objectReferences: [],
				cellReferences: [],
				referenceCount: 0,
				offset: 0,
			};
			into.set(key, item);
			order.push(item);
		}

		item.referenceCount = Math.max(item.referenceCount,
			declaration.objectReferenceCount + declaration.cellReferenceCount);

		switch (declaration.partition) {
			case Partition.ObjectMetadata: {
				if (data.data?.length !== 4) {
					throw new OneNoteFormatError('ONENOTE_FSSHTTPB_JCID',
						'Object metadata is not a four-byte type code.');
				}
				const bytes = data.data;
				item.jcid = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
				break;
			}
			case Partition.ObjectData:
				item.propertyData = data.data;
				item.objectReferences = data.objectReferences;
				item.cellReferences = data.cellReferences;
				break;
			case Partition.ObjectFileData:
				item.blob = data.blob ?? declaration.blob;
				break;
			default:
				// An unknown partition carries something this reader has no use
				// for. Skipping it loses nothing the semantic layer reads.
				break;
		}
	}
}

/**
 * Build the object graph for a packaged section.
 *
 * The chain followed is the one the format describes: storage manifest roots
 * name cells, the storage index maps a cell to its manifest, a cell manifest
 * names its current revision, the index maps that to a revision manifest, and
 * the revision names the object groups holding its objects.
 */
export function buildObjectGraph(
	data: Uint8Array,
	options: ReaderOptions = DEFAULT_READER_OPTIONS,
	parsed: DataElementPackage = readDataElementPackage(data),
): ObjectGraph {
	const working = new Map<string, WorkingRevision>();
	const byRevisionId = new Map<string, WorkingRevision>();

	for (const [elementKey, manifest] of parsed.revisionManifests) {
		const revision: WorkingRevision = {
			manifest: {
				id: toStoreGuid(manifest.revision),
				dependencyId: isNullExtendedGuid(manifest.baseRevision) ? undefined : toStoreGuid(manifest.baseRevision),
				role: 0,
				isEncrypted: false,
				rootObjects: manifest.roots.map((root): RootObjectReference => ({
					objectId: toStoreGuid(root.object),
					role: root.root.value,
				})),
				roleAssociations: [] as RoleAssociation[],
			},
			objectGroups: manifest.objectGroups,
		};

		working.set(elementKey, revision);
		byRevisionId.set(extendedGuidKey(manifest.revision), revision);
	}

	// Each cell contributes one object space, and its revision chain inherits it.
	const revisionElementByRevisionId = new Map(
		parsed.storageIndex.revisionMappings.map(mapping => [extendedGuidKey(mapping.revision), mapping.id]));
	let order = 0;

	for (const mapping of parsed.storageIndex.cellMappings) {
		const cellManifest = parsed.cellManifests.get(extendedGuidKey(mapping.id));
		if (!cellManifest) continue;

		const elementId = revisionElementByRevisionId.get(extendedGuidKey(cellManifest.currentRevision));
		if (!elementId) continue;

		const current = working.get(extendedGuidKey(elementId));
		if (!current) continue;

		assignCell(current, mapping.cell, byRevisionId, order++);
	}

	const graph: ObjectGraph = { revisions: [], objects: [], fileDataObjects: [] };
	const placed = new Set<string>();

	for (const revision of working.values()) {
		if (!revision.manifest.objectSpaceId) continue;
		graph.revisions.push(revision.manifest);
	}

	for (const revision of working.values()) {
		if (!revision.manifest.objectSpaceId || !revision.cell) continue;

		const objects = new Map<string, Accumulated>();
		const ordered: Accumulated[] = [];

		for (const groupId of revision.objectGroups) {
			const group = parsed.objectGroups.get(extendedGuidKey(groupId));
			if (group) accumulate(group, objects, ordered);
		}

		for (const item of ordered) {
			if (graph.objects.length >= options.maxObjects) {
				throw new OneNoteFormatError('ONENOTE_OBJECT_LIMIT', 'The object declaration limit was exceeded.');
			}

			const record: RevisionStoreObject = {
				id: toStoreGuid(item.id),
				jcid: item.jcid,
				referenceCount: item.referenceCount,
				revisionId: revision.manifest.id,
				// An object seen in an earlier revision is that revision's,
				// carried forward rather than declared afresh.
				isRevision: placed.has(keyOf(toStoreGuid(item.id))),
			};
			placed.add(keyOf(toStoreGuid(item.id)));

			if (item.propertyData) {
				const globalIds = buildGlobalIds(item, revision.cell);
				record.propertySet = readPropertySet(item.propertyData, globalIds, options, 0);

				// A packaged file-data object carries its reference as a property
				// rather than in a declaration of its own.
				record.fileDataReference = readString(record, Property.fileDataReference);
				record.fileExtension = readString(record, Property.fileDataExtension);
			}

			graph.objects.push(record);

			const payload = item.blob && parsed.blobs.get(extendedGuidKey(item.blob));
			const referenceId = fileDataId(record.fileDataReference);
			if (payload && referenceId && !graph.fileDataObjects.some(entry => entry.referenceId === referenceId)) {
				graph.fileDataObjects.push({ referenceId, payload } satisfies FileDataStoreObject);
			}
		}
	}

	return graph;
}

/** `<ifndf>{GUID}` names a file in the data store; anything else names nothing. */
function fileDataId(reference: string | undefined): string | undefined {
	if (!reference || !reference.toLowerCase().startsWith('<ifndf>')) return undefined;
	return reference.slice(7).trim().replace(/\0+$/, '').replace(/^\{|\}$/g, '').toLowerCase();
}

/**
 * Give a revision and everything it depends on the object space of its cell.
 *
 * Only the head of the chain is the current revision for that space; the rest
 * are its history, and marking more than one current would make the choice of
 * which to materialize arbitrary.
 */
function assignCell(
	head: WorkingRevision,
	cell: CellId,
	byRevisionId: Map<string, WorkingRevision>,
	order: number,
): void {
	const visited = new Set<string>();
	let revision: WorkingRevision | undefined = head;
	let isCurrent = true;

	while (revision && !visited.has(keyOf(revision.manifest.id))) {
		visited.add(keyOf(revision.manifest.id));

		revision.cell = cell;
		revision.manifest.objectSpaceId = toStoreGuid(cell.second);
		revision.manifest.contextId = isDefaultContext(cell.first) ? undefined : toStoreGuid(cell.first);

		if (isCurrent) {
			revision.manifest.role = 1;
			revision.manifest.roleAssociations.push({
				contextId: revision.manifest.contextId,
				role: 1,
				order,
			});
			isCurrent = false;
		}

		const dependency: StoreExtendedGuid | undefined = revision.manifest.dependencyId;
		revision = dependency ? byRevisionId.get(keyOf(dependency)) : undefined;
	}
}
