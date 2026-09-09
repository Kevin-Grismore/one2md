/**
 * Object spaces, resolved from the index rather than materialized from it.
 *
 * `ObjectSpaceMaterializer` keeps five maps, and every one of them is as large
 * as the section: revisions by identifier, revisions by space, objects by
 * revision, file data by reference, and a cache of every space it has ever
 * been asked for — each holding the fully decoded structure. Converting a
 * section touches all of it, so all of it stays live for the whole conversion.
 *
 * The replay it performs, though, is small. A space is one revision chain, and
 * a chain is a walk from the current revision down its dependencies, applying
 * each revision's declarations oldest-first so that later ones win. Nothing
 * about that needs the whole section in memory; it needs the ability to ask
 * three questions — which revisions belong to a space, what a revision
 * declares, and which revision an identifier names — and the index answers all
 * three from disk.
 *
 * So this keeps the same replay and moves the tables into the paged store. A
 * resolved space becomes a slot number; its object map, its roots and its chain
 * are records under that slot. The heap holds the slot and a cursor, and a
 * section with a million objects costs the same as one with ten.
 *
 * ## The two encodings
 *
 * A desktop revision knows its own object space: the revision manifest names
 * it, and the index records it. A packaged revision does not. Its space comes
 * from the cell it belongs to, and finding that means following the chain the
 * format describes — manifest roots name cells, the storage index maps a cell
 * to its manifest, the manifest names its current revision, and the revision's
 * dependencies inherit the same cell. The indexer left that chain alone on
 * purpose, and `#assignCells` below is where it gets followed, once, into the
 * same store.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { HEADER_CELL_OBJECT_SPACE_ID } from '../onenote-file/semantic/schema';
import { PackageIndexedSection } from '../indexing/fsshttpb-index';
import {
	IndexedGuid,
	indexedGuidKey,
	ObjectDescriptor,
	SectionIndex,
} from '../indexing/section-index';
import { ByteRange } from '../storage/byte-source';
import { ByteWindow } from '../storage/byte-window';
import { PagedKeyValueStore } from '../storage/paged-key-value-store';
import { RecordReader, RecordWriter } from '../storage/records';
import { CompactIds, PropertyStore, PropertySetView } from './property-view';
import { RangeReader } from './range-reader';

const NIL_GUID = '00000000-0000-0000-0000-000000000000';

/**
 * The context every section shares. A cell naming it is the default context
 * rather than a distinct one, and treating it as distinct would split one
 * object space into two that never resolve.
 */
const DEFAULT_CONTEXT_GUID = '84defab9-aaa3-4a0d-a3a8-520c77ac7073';

function isNilGuid(id: IndexedGuid): boolean {
	return id.identifier === NIL_GUID && id.value === 0;
}

function isDefaultContext(id: IndexedGuid): boolean {
	return isNilGuid(id) || (id.identifier === DEFAULT_CONTEXT_GUID && id.value === 1);
}

/** A key that only has to exist; nothing reads a value back from it. */
const EMPTY = new Uint8Array(0);

const Tag = {
	/** Revision orders sharing one identifier, and how many there are. */
	revisionByGuid: 10,
	revisionByGuidCount: 11,
	/** Distinct object spaces in first-appearance order. */
	spaceOrdinal: 12,
	spaceByOrdinal: 13,
	/** Revision orders belonging to one space, and how many. */
	spaceRevision: 14,
	spaceRevisionCount: 15,
	/** A packaged revision's derived cell and context. */
	cell: 16,
	cellVisited: 24,
	cellAssociation: 25,
	cellAssociationCount: 26,
	/** Slot allocated to a resolved space, by space key. */
	slot: 17,
	/** Inside a slot: the replayed object map, the roots, the chain. */
	slotObject: 18,
	slotRoot: 19,
	slotChain: 20,
	slotVisited: 21,
	/** Cached CompactID pairs for one packaged object. */
	packagedIds: 22,
	packagedIdsBuilt: 23,
} as const;

export function spaceKey(id: IndexedGuid, contextId?: IndexedGuid): string {
	return `${indexedGuidKey(id)}|${contextId ? indexedGuidKey(contextId) : 'default'}`;
}

/** What a revision contributes to the space it belongs to. */
interface RevisionPlacement {
	objectSpaceId?: IndexedGuid;
	contextId?: IndexedGuid;
	role: number;
	isEncrypted: boolean;
}

interface Association {
	contextId?: IndexedGuid;
	role: number;
	order: number;
}

/**
 * A resolved space: the object map for one revision chain.
 *
 * Every answer is a store lookup, so holding one of these costs a slot number
 * whether the space has three objects or three hundred thousand.
 */
export class ResolvedSpace {
	readonly slot: number;
	readonly currentRevision: number;

	readonly #owner: SpaceResolver;

	constructor(owner: SpaceResolver, slot: number, currentRevision: number) {
		this.#owner = owner;
		this.slot = slot;
		this.currentRevision = currentRevision;
	}

	object(id: IndexedGuid): ObjectDescriptor | undefined {
		return this.#owner.objectInSlot(this.slot, id);
	}

	root(role: number): ObjectDescriptor | undefined {
		return this.#owner.rootInSlot(this.slot, role);
	}

	/** The property set of an object in this space, or nothing if it has none. */
	properties(object: ObjectDescriptor | undefined): PropertySetView | undefined {
		return object && this.#owner.propertiesOf(object);
	}

	/** The set of the object an identifier names, in one step. */
	propertiesOf(id: IndexedGuid): PropertySetView | undefined {
		return this.properties(this.object(id));
	}
}

export class SpaceResolver {
	readonly index: SectionIndex;
	readonly window: ByteWindow;
	readonly store: PagedKeyValueStore;
	readonly properties: PropertyStore;

	readonly #key = new RecordWriter(48);
	readonly #value = new RecordWriter(64);
	/**
	 * Writers used only by `#bump`.
	 *
	 * `RecordWriter.done()` hands back a view that the next `reset()` on the
	 * same writer invalidates. A counter's key has to stay valid while the
	 * record it counts is written, so it cannot come from the writer that
	 * record uses.
	 */
	readonly #counterKey = new RecordWriter(48);
	readonly #counterValue = new RecordWriter(8);
	readonly #packaged?: PackageIndexedSection;

	#spaces = 0;
	#slots = 0;

	constructor(index: SectionIndex, window: ByteWindow, store: PagedKeyValueStore, propertyTagBase: number) {
		this.index = index;
		this.window = window;
		this.store = store;
		this.properties = new PropertyStore(window, store, index.options, propertyTagBase);
		this.#packaged = index.encoding === 'file-synchronization-package'
			? index as PackageIndexedSection
			: undefined;

		this.#groupRevisions();
		if (this.#packaged) this.#assignCells(this.#packaged);
		this.#collectSpaces();
	}

	/** How many distinct object spaces the section holds. */
	get spaceCount(): number {
		return this.#spaces;
	}

	// -- Construction -------------------------------------------------------

	/**
	 * Group revision orders by identifier.
	 *
	 * Two revisions can carry the same identifier, and the eager reader treats
	 * that as one revision for the purpose of what it declares while following
	 * dependencies through the last of them. Keeping every order under its
	 * identifier is what lets both of those hold here too.
	 */
	#groupRevisions(): void {
		for (const revision of this.index.revisions()) {
			const count = this.#bump(writer => writer.reset(Tag.revisionByGuidCount).extendedGuid(revision.id));
			this.store.set(
				this.#key.reset(Tag.revisionByGuid).extendedGuid(revision.id).u32(count).done(),
				this.#value.reset().u32(revision.order).done());
		}
	}

	/**
	 * Give every packaged revision the cell it belongs to.
	 *
	 * This is `assignCell` from the object-graph builder, following the same
	 * chain in the same order so that the association orders — which decide
	 * which revision is current for a space — come out the same. Only the head
	 * of a chain is current; the rest are its history.
	 */
	#assignCells(index: PackageIndexedSection): void {
		let order = 0;

		for (let position = 0; position < index.cellMappingCount; position++) {
			const mapping = index.cellMappingAt(position);
			const currentRevision = index.cellManifest(mapping.id);
			if (!currentRevision) continue;

			const head = this.#revisionElementFor(index, currentRevision);
			if (head === undefined) continue;

			const contextId = isDefaultContext(mapping.cell.first) ? undefined : mapping.cell.first;

			let revision: number | undefined = head;
			let isCurrent = true;

			while (revision !== undefined) {
				// The chain's own visited set, on disk: a dependency graph that
				// loops must not become an endless walk, and a section with a
				// hundred thousand revisions must not become a set of that size.
				const visited = this.#key.reset(Tag.cellVisited).u32(position).u32(revision).done();
				if (this.store.has(visited)) break;
				this.store.set(visited, EMPTY);

				const descriptor = this.index.revisionAt(revision);

				// The cell a revision last belongs to wins, as it does upstream.
				this.store.set(
					this.#key.reset(Tag.cell).u32(revision).done(),
					this.#value.reset()
						.extendedGuid(mapping.cell.first)
						.extendedGuid(mapping.cell.second)
						.optionalExtendedGuid(contextId)
						.done());

				// Associations accumulate rather than replace: one revision can
				// be the current one for more than one cell, and each of those
				// contributes an order that the choice of current depends on.
				if (isCurrent) {
					const at = revision;
					const count = this.#bump(writer => writer.reset(Tag.cellAssociationCount).u32(at));
					this.store.set(
						this.#key.reset(Tag.cellAssociation).u32(at).u32(count).done(),
						this.#value.reset().optionalExtendedGuid(contextId).u32(1).u32(order).done());
					isCurrent = false;
				}

				const dependency: IndexedGuid | undefined = descriptor.dependencyId;
				revision = dependency ? this.#lastRevisionFor(dependency) : undefined;
			}

			order++;
		}
	}

	/** Which revision the storage index maps a revision identifier to. */
	#revisionElementFor(index: PackageIndexedSection, revisionId: IndexedGuid): number | undefined {
		for (let position = 0; position < index.revisionMappingCount; position++) {
			const mapping = index.revisionMappingAt(position);
			if (indexedGuidKey(mapping.revision) !== indexedGuidKey(revisionId)) continue;
			return index.revisionOfElement(mapping.id);
		}

		return undefined;
	}

	/**
	 * Enumerate object spaces in the order the eager reader meets them.
	 *
	 * `findCurrentSpaceByRootJcid` takes the first space whose root is a
	 * section node, so this order is part of the output: it decides which space
	 * a section with more than one candidate converts from.
	 */
	#collectSpaces(): void {
		for (const revision of this.index.revisions()) {
			const placement = this.#placementOf(revision.order);
			if (!placement.objectSpaceId) continue;

			const spaceGuid = placement.objectSpaceId;
			let ordinal = this.#number(this.#key.reset(Tag.spaceOrdinal).extendedGuid(spaceGuid).done());

			if (ordinal === undefined) {
				ordinal = this.#spaces++;
				this.store.set(
					this.#key.reset(Tag.spaceByOrdinal).u32(ordinal).done(),
					this.#value.reset().extendedGuid(spaceGuid).done());
				this.store.set(
					this.#key.reset(Tag.spaceOrdinal).extendedGuid(spaceGuid).done(),
					this.#value.reset().u32(ordinal).done());
			}

			const at = ordinal;
			const count = this.#bump(writer => writer.reset(Tag.spaceRevisionCount).u32(at));
			this.store.set(
				this.#key.reset(Tag.spaceRevision).u32(at).u32(count).done(),
				this.#value.reset().u32(revision.order).done());
		}
	}

	// -- Placement ----------------------------------------------------------

	/** Where a revision sits: its space, its context, and whether it is current. */
	#placementOf(revision: number): RevisionPlacement {
		const descriptor = this.index.revisionAt(revision);
		if (!this.#packaged) {
			return {
				objectSpaceId: descriptor.objectSpaceId,
				contextId: descriptor.contextId,
				role: descriptor.role,
				isEncrypted: descriptor.isEncrypted,
			};
		}

		const stored = this.store.get(this.#key.reset(Tag.cell).u32(revision).done());
		if (!stored) return { role: 0, isEncrypted: false };

		const reader = new RecordReader(stored);
		reader.extendedGuid();
		const objectSpaceId = reader.extendedGuid();
		const contextId = reader.optionalExtendedGuid();
		const current = (this.#number(this.#key.reset(Tag.cellAssociationCount).u32(revision).done()) ?? 0) > 0;

		return { objectSpaceId, contextId, role: current ? 1 : 0, isEncrypted: false };
	}

	/** The cell a packaged revision belongs to, which its CompactIDs need. */
	cellOf(revision: number): { first: IndexedGuid, second: IndexedGuid } | undefined {
		const stored = this.store.get(this.#key.reset(Tag.cell).u32(revision).done());
		if (!stored) return undefined;

		const reader = new RecordReader(stored);
		return { first: reader.extendedGuid(), second: reader.extendedGuid() };
	}

	*#associationsOf(revision: number): IterableIterator<Association> {
		if (!this.#packaged) {
			yield* this.index.roleAssociationsOf(revision);
			return;
		}

		const count = this.#number(this.#key.reset(Tag.cellAssociationCount).u32(revision).done()) ?? 0;
		for (let position = 0; position < count; position++) {
			const stored = this.store.get(
				this.#key.reset(Tag.cellAssociation).u32(revision).u32(position).done())!;
			const reader = new RecordReader(stored);
			yield { contextId: reader.optionalExtendedGuid(), role: reader.u32(), order: reader.u32() };
		}
	}

	// -- Resolution ---------------------------------------------------------

	/**
	 * The first space whose primary root is an object of the given type.
	 *
	 * The header cell's own space is skipped, as the eager reader skips it: it
	 * describes the file rather than holding any of its content.
	 */
	currentSpaceByRootJcid(jcid: number): ResolvedSpace | undefined {
		for (let ordinal = 0; ordinal < this.#spaces; ordinal++) {
			const spaceGuid = this.#spaceAt(ordinal);
			if (spaceGuid.identifier === HEADER_CELL_OBJECT_SPACE_ID && spaceGuid.value === 1) continue;

			const space = this.tryGetSpace(spaceGuid);
			if (space?.root(1)?.jcid === jcid) return space;
		}

		return undefined;
	}

	tryGetSpace(id: IndexedGuid, contextId?: IndexedGuid): ResolvedSpace | undefined {
		const key = spaceKey(id, contextId);
		const cached = this.store.get(this.#key.reset(Tag.slot).text(key).done());
		if (cached) {
			const reader = new RecordReader(cached);
			const slot = reader.i32();
			return slot < 0 ? undefined : new ResolvedSpace(this, slot, reader.u32());
		}

		// Resolving writes through the same key writer, so the cache key is
		// built again afterwards rather than held across it.
		const resolved = this.#resolve(id, contextId);
		this.store.set(
			this.#key.reset(Tag.slot).text(key).done(),
			this.#value.reset()
				.i32(resolved ? resolved.slot : -1)
				.u32(resolved ? resolved.currentRevision : 0)
				.done());

		return resolved;
	}

	#resolve(id: IndexedGuid, contextId?: IndexedGuid): ResolvedSpace | undefined {
		const ordinal = this.#number(this.#key.reset(Tag.spaceOrdinal).extendedGuid(id).done());
		if (ordinal === undefined) return undefined;

		const count = this.#number(this.#key.reset(Tag.spaceRevisionCount).u32(ordinal).done()) ?? 0;

		let current: number | undefined;
		let bestOrder = -1;

		for (let position = 0; position < count; position++) {
			const revision = this.#number(
				this.#key.reset(Tag.spaceRevision).u32(ordinal).u32(position).done())!;
			if (this.#placementOf(revision).isEncrypted) continue;

			for (const association of this.#associationsOf(revision)) {
				if (association.role !== 1) continue;
				if (!contextEquals(association.contextId, contextId)) continue;
				if (association.order >= bestOrder) {
					bestOrder = association.order;
					current = revision;
				}
			}
		}

		if (current === undefined) return undefined;

		const slot = this.#slots++;
		this.#replay(slot, current);
		return new ResolvedSpace(this, slot, current);
	}

	/**
	 * Apply a revision chain into a slot, oldest revision first.
	 *
	 * The chain is walked newest-first because that is the direction the
	 * dependency links point, recorded as it goes, and then applied in reverse
	 * — so a declaration in a later revision replaces the one it revises, which
	 * is what makes the newest state the one a lookup finds.
	 */
	#replay(slot: number, current: number): void {
		let depth = 0;
		let revision: number | undefined = current;

		while (revision !== undefined) {
			const id = this.index.revisionAt(revision).id;
			const visited = this.#key.reset(Tag.slotVisited).u32(slot).extendedGuid(id).done();
			if (this.store.has(visited)) break;
			this.store.set(visited, this.#value.reset().u32(depth).done());

			this.store.set(
				this.#key.reset(Tag.slotChain).u32(slot).u32(depth++).done(),
				this.#value.reset().u32(revision).done());

			const dependency: IndexedGuid | undefined = this.index.revisionAt(revision).dependencyId;
			revision = dependency ? this.#lastRevisionFor(dependency) : undefined;
		}

		for (let position = depth - 1; position >= 0; position--) {
			const chained = this.#number(this.#key.reset(Tag.slotChain).u32(slot).u32(position).done())!;
			const id = this.index.revisionAt(chained).id;

			// Every revision order sharing this identifier contributes, which is
			// how the eager reader groups a revision's declarations.
			for (const order of this.#ordersFor(id)) {
				for (const object of this.index.objectsOf(order)) {
					this.store.set(
						this.#key.reset(Tag.slotObject).u32(slot).extendedGuid(object.id).done(),
						this.#value.reset().u32(object.order).done());
				}
			}

			for (const root of this.index.rootObjectsOf(chained)) {
				this.store.set(
					this.#key.reset(Tag.slotRoot).u32(slot).u32(root.role).done(),
					this.#value.reset().extendedGuid(root.objectId).done());
			}
		}
	}

	/** @internal */
	objectInSlot(slot: number, id: IndexedGuid): ObjectDescriptor | undefined {
		const order = this.#number(this.#key.reset(Tag.slotObject).u32(slot).extendedGuid(id).done());
		return order === undefined ? undefined : this.index.objectAt(order);
	}

	/** @internal */
	rootInSlot(slot: number, role: number): ObjectDescriptor | undefined {
		const stored = this.store.get(this.#key.reset(Tag.slotRoot).u32(slot).u32(role).done());
		if (!stored) return undefined;
		return this.objectInSlot(slot, new RecordReader(stored).extendedGuid());
	}

	// -- Objects ------------------------------------------------------------

	/**
	 * The property set of one object, whichever encoding named it.
	 *
	 * The identifiers a set refers to are resolved differently in the two
	 * encodings, and this is where that is decided — the only place above the
	 * index where it has to be.
	 */
	propertiesOf(object: ObjectDescriptor): PropertySetView | undefined {
		if (!object.propertySet) return undefined;
		return this.properties.viewOf(object.order, object.propertySet, this.compactIdsFor(object));
	}

	compactIdsFor(object: ObjectDescriptor): CompactIds {
		if (!this.#packaged) return new DesktopCompactIds(this.index, object.globalIdScope ?? -1);
		return new PackagedCompactIds(this, object);
	}

	/**
	 * The bytes an object's file-data reference names, as a range.
	 *
	 * The two encodings link an object to its bytes differently. A desktop
	 * object carries the `<ifndf>{GUID}` name of an entry in the file-data
	 * store, and the index is keyed by exactly that. A packaged object carries
	 * the same reference as a property, but the bytes are in a data element the
	 * object itself declared — so the declaration is followed rather than the
	 * name, which is both shorter and what the format actually links.
	 */
	fileDataRangeOf(object: ObjectDescriptor): ByteRange | undefined {
		if (this.#packaged) {
			return object.blobId
				? this.index.fileData(indexedGuidKey(object.blobId))?.payload
				: undefined;
		}

		const reference = object.fileDataReference;
		if (!reference || !reference.toLowerCase().startsWith('<ifndf>')) return undefined;

		const value = reference.slice(7).trim().replace(/\0+$/, '').replace(/^\{|\}$/g, '').toLowerCase();
		return this.index.fileData(value)?.payload;
	}

	// -- Store helpers ------------------------------------------------------

	#spaceAt(ordinal: number): IndexedGuid {
		const stored = this.store.get(this.#key.reset(Tag.spaceByOrdinal).u32(ordinal).done())!;
		return new RecordReader(stored).extendedGuid();
	}

	*#ordersFor(id: IndexedGuid): IterableIterator<number> {
		const count = this.#number(this.#key.reset(Tag.revisionByGuidCount).extendedGuid(id).done()) ?? 0;
		for (let position = 0; position < count; position++) {
			yield this.#number(this.#key.reset(Tag.revisionByGuid).extendedGuid(id).u32(position).done())!;
		}
	}

	/** The last revision order carrying an identifier, as the eager map keeps. */
	#lastRevisionFor(id: IndexedGuid): number | undefined {
		let last: number | undefined;
		for (const order of this.#ordersFor(id)) last = order;
		return last;
	}

	#number(key: Uint8Array): number | undefined {
		const stored = this.store.get(key);
		return stored ? new RecordReader(stored).u32() : undefined;
	}

	/** Read a counter, store it incremented, and answer with the old value. */
	#bump(build: (writer: RecordWriter) => RecordWriter): number {
		const key = build(this.#counterKey).done();
		const count = this.#number(key) ?? 0;
		this.store.set(key, this.#counterValue.reset().u32(count + 1).done());
		return count;
	}

	/** @internal Used by the packaged identifier table. */
	get sharedStore(): PagedKeyValueStore {
		return this.store;
	}
}

function contextEquals(left: IndexedGuid | undefined, right: IndexedGuid | undefined): boolean {
	if (!left) return !right;
	if (!right) return false;
	return indexedGuidKey(left) === indexedGuidKey(right);
}

/**
 * A desktop CompactID table: the scope the object was declared under.
 *
 * The index already holds these on disk, one record per entry, so this is a
 * lookup and nothing more.
 */
class DesktopCompactIds implements CompactIds {
	constructor(private readonly index: SectionIndex, private readonly scope: number) {}

	identifier(globalIndex: number): string | undefined {
		return this.scope < 0 ? undefined : this.index.globalId(this.scope, globalIndex);
	}
}

/**
 * A packaged CompactID table, built from the object's own reference arrays.
 *
 * A packaged object has no global table to consult. Its property data begins
 * with the CompactIDs it uses, and the object declaration beside it carries the
 * Extended GUIDs they stand for, positionally. Pairing the two is what makes a
 * reference resolvable — and the pairing is validated, because a mismatch
 * between the arrays is detectable and means the file is wrong rather than that
 * a guess should be made.
 *
 * The pairs go into the store the first time an object is read, so an object
 * referenced from a hundred places is paired once.
 */
class PackagedCompactIds implements CompactIds {
	readonly #resolver: SpaceResolver;
	readonly #object: ObjectDescriptor;
	readonly #key = new RecordWriter(24);

	constructor(resolver: SpaceResolver, object: ObjectDescriptor) {
		this.#resolver = resolver;
		this.#object = object;
	}

	identifier(globalIndex: number): string | undefined {
		this.#ensureBuilt();

		const stored = this.#resolver.sharedStore.get(
			this.#key.reset(Tag.packagedIds).u32(this.#object.order).u32(globalIndex).done());
		return stored ? new RecordReader(stored).guid() : undefined;
	}

	#ensureBuilt(): void {
		const store = this.#resolver.sharedStore;
		if (store.has(this.#key.reset(Tag.packagedIdsBuilt).u32(this.#object.order).done())) return;

		const index = this.#resolver.index as PackageIndexedSection;
		const value = this.#object.propertySet!;
		const streams = readStreamRanges(this.#resolver.window, value);

		// A cell reference in the object's own space names an object space; one
		// in another space names a context. The current cell separates them.
		const cell = this.#object.revisionOrder >= 0
			? this.#resolver.cellOf(this.#object.revisionOrder)
			: undefined;

		this.#pair(streams.object, this.#objectReferences(index), value.offset, 'object');

		if (streams.objectSpace) {
			this.#pair(streams.objectSpace, this.#cellReferences(index, cell, true), value.offset, 'object-space');
		}
		if (streams.context) {
			this.#pair(streams.context, this.#cellReferences(index, cell, false), value.offset, 'context');
		}

		// Marked last, and built again from the key writer that pairing reused.
		store.set(
			this.#key.reset(Tag.packagedIdsBuilt).u32(this.#object.order).done(),
			EMPTY);
	}

	*#objectReferences(index: PackageIndexedSection): IterableIterator<IndexedGuid> {
		yield* index.extendedGuidsIn(this.#object.objectReferences);
	}

	*#cellReferences(
		index: PackageIndexedSection,
		cell: { first: IndexedGuid, second: IndexedGuid } | undefined,
		own: boolean,
	): IterableIterator<IndexedGuid> {
		const cellKey = cell ? indexedGuidKey(cell.first) : undefined;

		for (const reference of index.cellIdsIn(this.#object.cellReferences)) {
			const matches = indexedGuidKey(reference.first) === cellKey;
			if (matches !== own) continue;
			yield own ? reference.second : reference.first;
		}
	}

	/**
	 * Pair a CompactID stream with the Extended GUIDs it stands for.
	 *
	 * The low byte of a CompactID repeats the Extended GUID's ordinal, so a
	 * misalignment is visible rather than silent. This is `addMappings` with the
	 * arrays replaced by two cursors.
	 */
	#pair(stream: ByteRange, extended: IterableIterator<IndexedGuid>, offset: number, kind: string): void {
		const store = this.#resolver.sharedStore;
		const reader = new RangeReader(this.#resolver.window, stream);
		const count = stream.length >>> 2;
		const writer = new RecordWriter(24);
		let position = 0;

		for (const id of extended) {
			if (position >= count) {
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MAPPING_COUNT',
					`The ${kind} CompactID and Extended GUID arrays have different lengths.`, offset);
			}

			const compact = reader.u32(position * 4);
			position++;

			if (compact === 0 && isNilGuid(id)) continue;

			const globalIndex = compact >>> 8;
			const ordinal = compact & 0xff;

			if (globalIndex >= 0xffffff || id.identifier === NIL_GUID || id.value !== ordinal) {
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MAPPING',
					`A ${kind} mapping pairs a CompactID with an incompatible Extended GUID.`, offset);
			}

			const existing = store.get(
				this.#key.reset(Tag.packagedIds).u32(this.#object.order).u32(globalIndex).done());
			if (existing !== undefined && new RecordReader(existing).guid() !== id.identifier) {
				throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MAPPING',
					'One CompactID global index maps to two different GUIDs.', offset);
			}

			store.set(
				this.#key.reset(Tag.packagedIds).u32(this.#object.order).u32(globalIndex).done(),
				writer.reset().guid(id.identifier).done());
		}

		if (position !== count) {
			throw new OneNoteFormatError('ONENOTE_FSSHTTPB_MAPPING_COUNT',
				`The ${kind} CompactID and Extended GUID arrays have different lengths.`, offset);
		}
	}
}

/** The three identifier streams at the front of a property value. */
function readStreamRanges(window: ByteWindow, value: ByteRange): {
	object: ByteRange,
	objectSpace?: ByteRange,
	context?: ByteRange,
} {
	const reader = new RangeReader(window, value);

	const read = (offset: number) => {
		const header = reader.u32(offset);
		return {
			range: { offset: value.offset + offset + 4, length: (header & 0x00ffffff) * 4 },
			extended: (header & 0x40000000) !== 0,
			noOsid: (header & 0x80000000) !== 0,
		};
	};

	const object = read(0);
	let offset = 4 + object.range.length;
	let objectSpace: ByteRange | undefined;
	let context: ByteRange | undefined;

	if (!object.noOsid) {
		const osids = read(offset);
		objectSpace = osids.range;
		offset += 4 + osids.range.length;

		if (osids.extended) context = read(offset).range;
	}

	return { object: object.range, objectSpace, context };
}
