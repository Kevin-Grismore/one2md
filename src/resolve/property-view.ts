/**
 * Property sets, read where they lie.
 *
 * `readPropertySet` decodes a set into an object graph: one `PropertyValue` per
 * property, each holding an owned copy of its bytes, every referenced
 * identifier expanded into an `ExtendedGuid`, and every nested set built in
 * turn. For one object that is nothing. For a section it is the largest
 * structure the old reader builds, and it is built for every object whether the
 * conversion goes on to ask for any of it.
 *
 * This reads the same layout without building it. A set is walked once, and
 * what the walk records is a fixed-size descriptor per property — where its
 * bytes are, not what they are — written into the paged store. Values are
 * fetched, in chunks, only when something asks for one. The walk is cached by
 * object, so asking twice costs a lookup rather than a second parse.
 *
 * Nothing here decides what a property means. That stays in the schema and in
 * the readers above, which is why the same limits, the same error codes and the
 * same trailing-NUL and NFC rules still apply: only where the bytes come from
 * has changed.
 *
 * ## Identifiers
 *
 * A property does not name an object directly. It names a CompactID, which is
 * an index into a table that the two encodings build in completely different
 * ways — the desktop store keeps a global-identification table per file-node
 * list, and a packaged object carries its own reference array. `CompactIds`
 * below is that difference, and the only one: everything else in a property set
 * is identical between them.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { ReaderOptions } from '../onenote-file/onestore/options';
import { ByteRange } from '../storage/byte-source';
import { ByteWindow } from '../storage/byte-window';
import { PagedKeyValueStore } from '../storage/paged-key-value-store';
import { RecordReader, RecordWriter } from '../storage/records';
import { RangeReader } from './range-reader';

/** Which stream a property's references are taken from. */
export const ReferenceKind = {
	object: 0,
	objectSpace: 1,
	context: 2,
} as const;

export interface PropertyRef {
	rawId: number;
	/** Position within its set, as `PropertyValue.index` counts. */
	index: number;
	/** The representation type, from the top bits of the raw identifier. */
	type: number;
	booleanValue?: boolean;
	/** Present when the value is a fixed-width integer that stayed exact. */
	scalarValue?: number;
	/** Where the value's bytes are, for a scalar or a length-prefixed value. */
	data?: ByteRange;
	referenceKind?: number;
	/** Position of the first identifier this property takes from its stream. */
	referenceStart?: number;
	referenceCount?: number;
	/** Nested sets, for a property-set or property-set-array value. */
	childCount?: number;
	childOffset?: number;
	childCounters?: [number, number, number];
}

/** The identifier a CompactID's global index stands for, however it is kept. */
export interface CompactIds {
	identifier(globalIndex: number): string | undefined;
}

export interface ResolvedId {
	identifier: string;
	value: number;
}

/**
 * The three positional identifier streams at the front of a property set.
 *
 * Each is a count followed by that many four-byte CompactIDs, which makes the
 * nth identifier a fixed offset rather than the nth element of an array. That
 * is the whole reason nothing here holds them: a property that takes three
 * identifiers starting at index nine reads twelve bytes at a computed offset,
 * whatever the stream's length.
 */
interface Streams {
	object: ByteRange;
	objectSpace?: ByteRange;
	context?: ByteRange;
	/** Where the root set begins, relative to the value's start. */
	rootOffset: number;
}

const Tag = {
	/** One record per object whose set has been walked. */
	parsed: 1,
	/** One record per set, per property identifier held in it. */
	property: 2,
} as const;

export class PropertyStore {
	readonly window: ByteWindow;
	readonly store: PagedKeyValueStore;
	readonly options: ReaderOptions;
	/** Namespace inside the store, so a caller can host several of these. */
	readonly tagBase: number;

	readonly #key = new RecordWriter(32);
	readonly #value = new RecordWriter(96);

	#slots = 0;

	constructor(window: ByteWindow, store: PagedKeyValueStore, options: ReaderOptions, tagBase: number) {
		this.window = window;
		this.store = store;
		this.options = options;
		this.tagBase = tagBase;
	}

	/**
	 * The set an object's data holds, walked at most once per object.
	 *
	 * `key` identifies the object for caching. Two objects that share a key
	 * would share a walk, so it has to be the object's index order, which is
	 * unique within a section.
	 */
	viewOf(key: number, value: ByteRange, ids: CompactIds): PropertySetView {
		const cached = this.store.get(this.#key.reset(this.tagBase + Tag.parsed).u32(key).done());
		if (cached) {
			const reader = new RecordReader(cached);
			const slot = reader.u32();
			return new PropertySetView(this, slot, value, ids, {
				object: reader.range(),
				objectSpace: reader.optionalRange(),
				context: reader.optionalRange(),
				rootOffset: reader.u32(),
			});
		}

		const slot = this.#slots++;
		const streams = this.#readStreams(value);
		const view = new PropertySetView(this, slot, value, ids, streams);

		this.#walk(slot, value, streams, streams.rootOffset, { object: 0, objectSpace: 0, context: 0 }, 0);
		this.store.set(
			this.#key.reset(this.tagBase + Tag.parsed).u32(key).done(),
			this.#value.reset()
				.u32(slot)
				.range(streams.object)
				.optionalRange(streams.objectSpace)
				.optionalRange(streams.context)
				.u32(streams.rootOffset)
				.done());

		return view;
	}

	/**
	 * A nested set, walked into a slot of its own.
	 *
	 * These are not cached: a nested set is reached through the property that
	 * holds it, is read once where it is used, and there are at most a handful
	 * per object. Giving each a fresh slot costs a few records rather than the
	 * bookkeeping that reusing one would need to stay correct.
	 */
	childView(parent: PropertySetView, property: PropertyRef, position: number): PropertySetView {
		const slot = this.#slots++;
		const counters = {
			object: property.childCounters![0],
			objectSpace: property.childCounters![1],
			context: property.childCounters![2],
		};

		let offset = property.childOffset!;
		// The children are laid out one after another and share the identifier
		// streams, so reaching the nth means walking the ones before it. Those
		// walks are for their length alone, so they record nothing.
		for (let index = 0; index < position; index++) {
			offset = this.#walk(undefined, parent.value, parent.streams, offset, counters, 1);
		}

		this.#walk(slot, parent.value, parent.streams, offset, counters, 1);
		return new PropertySetView(this, slot, parent.value, parent.ids, parent.streams);
	}

	/** @internal */
	lookup(slot: number, propertyId: number): PropertyRef | undefined {
		const stored = this.store.get(
			this.#key.reset(this.tagBase + Tag.property).u32(slot).u32(propertyId & 0x7fffffff).done());
		if (!stored) return undefined;

		const reader = new RecordReader(stored);
		const property: PropertyRef = { rawId: reader.u32(), index: reader.u32(), type: reader.u8() };

		if (reader.flag()) property.booleanValue = reader.flag();
		if (reader.flag()) property.scalarValue = reader.big();
		property.data = reader.optionalRange();

		if (reader.flag()) {
			property.referenceKind = reader.u8();
			property.referenceStart = reader.u32();
			property.referenceCount = reader.u32();
		}

		if (reader.flag()) {
			property.childCount = reader.u32();
			property.childOffset = reader.u32();
			property.childCounters = [reader.u32(), reader.u32(), reader.u32()];
		}

		return property;
	}

	#error(value: ByteRange, offset: number, code: string, message: string): OneNoteFormatError {
		return new OneNoteFormatError(code, message, value.offset + offset);
	}

	#readStreams(value: ByteRange): Streams {
		const reader = new RangeReader(this.window, value);
		let offset = 0;

		const object = this.#readStream(reader, value, offset);
		offset = object.range.length + 4;

		let objectSpace: ByteRange | undefined;
		let context: ByteRange | undefined;

		if (!object.osidStreamNotPresent) {
			const osids = this.#readStream(reader, value, offset);
			objectSpace = osids.range;
			offset += osids.range.length + 4;

			if (osids.extendedStreamsPresent) {
				const contexts = this.#readStream(reader, value, offset);
				context = contexts.range;
				offset += contexts.range.length + 4;
			}
		}

		return { object: object.range, objectSpace, context, rootOffset: offset };
	}

	#readStream(reader: RangeReader, value: ByteRange, offset: number): {
		range: ByteRange,
		extendedStreamsPresent: boolean,
		osidStreamNotPresent: boolean,
	} {
		this.#ensure(value, offset, 4);
		const header = reader.u32(offset);
		const count = header & 0x00ffffff;

		if ((header & 0x3f000000) !== 0 || count > this.options.maxObjects) {
			throw this.#error(value, offset, 'ONENOTE_OBJECT_STREAM_HEADER',
				'An object-reference stream header is invalid or exceeds the object limit.');
		}

		this.#ensure(value, offset + 4, count * 4);
		return {
			range: { offset: value.offset + offset + 4, length: count * 4 },
			extendedStreamsPresent: (header & 0x40000000) !== 0,
			osidStreamNotPresent: (header & 0x80000000) !== 0,
		};
	}

	#ensure(value: ByteRange, offset: number, length: number): void {
		if (length < 0 || offset > value.length - length) {
			throw this.#error(value, offset, 'ONENOTE_TRUNCATED_PROPERTY_SET',
				'The object data ended inside a property set.');
		}
	}

	/**
	 * Walk one set, recording a descriptor per property.
	 *
	 * This mirrors `Cursor.readPropertySet` case for case. What differs is that
	 * a value is skipped over rather than copied, and an identifier run is
	 * recorded as a position and a count rather than taken out of an array —
	 * the two places where the original's cost is proportional to the content.
	 */
	#walk(
		slot: number | undefined,
		value: ByteRange,
		streams: Streams,
		start: number,
		counters: { object: number, objectSpace: number, context: number },
		depth: number,
	): number {
		if (depth >= this.options.maxPropertySetDepth) {
			throw this.#error(value, start, 'ONENOTE_PROPERTY_DEPTH',
				'The nested property-set depth limit was exceeded.');
		}

		const reader = new RangeReader(this.window, value);
		let offset = start;

		this.#ensure(value, offset, 2);
		const count = reader.u16(offset);
		offset += 2;

		if (count > this.options.maxPropertiesPerObject) {
			throw this.#error(value, offset, 'ONENOTE_PROPERTY_LIMIT',
				'The property count exceeds the configured per-object limit.');
		}

		const idsOffset = offset;
		this.#ensure(value, idsOffset, count * 4);
		offset += count * 4;

		for (let index = 0; index < count; index++) {
			const rawId = reader.u32(idsOffset + index * 4);
			const type = (rawId >>> 26) & 0x1f;
			const property: PropertyRef = { rawId, index, type };

			switch (type) {
				case 0x01:
					break;
				case 0x02:
					property.booleanValue = (rawId & 0x80000000) !== 0;
					break;
				case 0x03:
					offset = this.#scalar(reader, value, property, offset, 1);
					break;
				case 0x04:
					offset = this.#scalar(reader, value, property, offset, 2);
					break;
				case 0x05:
					offset = this.#scalar(reader, value, property, offset, 4);
					break;
				case 0x06:
					offset = this.#scalar(reader, value, property, offset, 8);
					break;
				case 0x07: {
					this.#ensure(value, offset, 4);
					const length = reader.u32(offset);
					offset += 4;

					if (length >= 0x40000000) {
						throw this.#error(value, offset, 'ONENOTE_PROPERTY_DATA_LENGTH',
							'A length-prefixed property value is too large.');
					}

					this.#ensure(value, offset, length);
					property.data = { offset: value.offset + offset, length };
					offset += length;
					break;
				}
				case 0x08:
					this.#take(property, streams, counters, ReferenceKind.object, 1, value, offset);
					break;
				case 0x09: {
					const taken = this.#referenceCount(reader, value, offset);
					offset = taken.offset;
					this.#take(property, streams, counters, ReferenceKind.object, taken.count, value, offset);
					break;
				}
				case 0x0a:
					this.#take(property, streams, counters, ReferenceKind.objectSpace, 1, value, offset);
					break;
				case 0x0b: {
					const taken = this.#referenceCount(reader, value, offset);
					offset = taken.offset;
					this.#take(property, streams, counters, ReferenceKind.objectSpace, taken.count, value, offset);
					break;
				}
				case 0x0c:
					this.#take(property, streams, counters, ReferenceKind.context, 1, value, offset);
					break;
				case 0x0d: {
					const taken = this.#referenceCount(reader, value, offset);
					offset = taken.offset;
					this.#take(property, streams, counters, ReferenceKind.context, taken.count, value, offset);
					break;
				}
				case 0x10: {
					const taken = this.#referenceCount(reader, value, offset);
					offset = taken.offset;

					if (taken.count === 0) {
						property.childCount = 0;
						property.childOffset = offset;
						property.childCounters = [counters.object, counters.objectSpace, counters.context];
						break;
					}

					this.#ensure(value, offset, 4);
					const childPropertyId = reader.u32(offset);
					offset += 4;

					if (((childPropertyId >>> 26) & 0x1f) !== 0x11) {
						throw this.#error(value, offset, 'ONENOTE_PROPERTY_ARRAY_TYPE',
							'A property-set array does not declare PropertySet element values.');
					}

					property.childCount = taken.count;
					property.childOffset = offset;
					property.childCounters = [counters.object, counters.objectSpace, counters.context];

					// Walked now rather than on demand, because the identifier
					// counters advance through them and the properties that
					// follow depend on where they end up. Only the length and
					// the counters matter here, so nothing is recorded: a
					// nested set is walked again, into a slot, if it is read.
					for (let child = 0; child < taken.count; child++) {
						offset = this.#walk(undefined, value, streams, offset, counters, depth + 1);
					}
					break;
				}
				case 0x11:
					property.childCount = 1;
					property.childOffset = offset;
					property.childCounters = [counters.object, counters.objectSpace, counters.context];
					offset = this.#walk(undefined, value, streams, offset, counters, depth + 1);
					break;
				default:
					throw this.#error(value, offset, 'ONENOTE_PROPERTY_TYPE',
						`The property set contains an unsupported representation type 0x${type.toString(16).padStart(2, '0')}.`);
			}

			if (slot !== undefined) this.#record(slot, property);
		}

		return offset;
	}

	#scalar(reader: RangeReader, value: ByteRange, property: PropertyRef, offset: number, byteCount: number): number {
		this.#ensure(value, offset, byteCount);
		const bytes = reader.slice(offset, byteCount);

		let scalar = 0;
		let exact = true;
		for (let index = bytes.length - 1; index >= 0; index--) {
			if (scalar > Number.MAX_SAFE_INTEGER / 256) exact = false;
			scalar = scalar * 256 + bytes[index];
		}

		if (exact) property.scalarValue = scalar;
		property.data = { offset: value.offset + offset, length: byteCount };
		return offset + byteCount;
	}

	#referenceCount(reader: RangeReader, value: ByteRange, offset: number): { count: number, offset: number } {
		this.#ensure(value, offset, 4);
		const count = reader.u32(offset);

		if (count > this.options.maxObjects) {
			throw this.#error(value, offset, 'ONENOTE_REFERENCE_COUNT',
				'A property reference count exceeds the configured object limit.');
		}

		return { count, offset: offset + 4 };
	}

	#take(
		property: PropertyRef,
		streams: Streams,
		counters: { object: number, objectSpace: number, context: number },
		kind: number,
		count: number,
		value: ByteRange,
		offset: number,
	): void {
		const names = ['object', 'object-space', 'context'] as const;
		const fields = ['object', 'objectSpace', 'context'] as const;
		const field = fields[kind];
		const stream = streams[field];
		const available = stream ? stream.length >>> 2 : 0;
		const start = counters[field];

		if (count < 0 || start > available - count) {
			throw this.#error(value, offset, 'ONENOTE_REFERENCE_STREAM',
				`A property consumes more ${names[kind]} identifiers than its object stream contains.`);
		}

		property.referenceKind = kind;
		property.referenceStart = start;
		property.referenceCount = count;
		counters[field] = start + count;
	}

	#record(slot: number, property: PropertyRef): void {
		this.#value.reset()
			.u32(property.rawId)
			.u32(property.index)
			.u8(property.type);

		if (property.booleanValue === undefined) this.#value.flag(false);
		else this.#value.flag(true).flag(property.booleanValue);

		this.#value.optionalBig(property.scalarValue);
		this.#value.optionalRange(property.data);

		if (property.referenceKind === undefined) this.#value.flag(false);
		else {
			this.#value.flag(true)
				.u8(property.referenceKind)
				.u32(property.referenceStart!)
				.u32(property.referenceCount!);
		}

		if (property.childCount === undefined) this.#value.flag(false);
		else {
			this.#value.flag(true)
				.u32(property.childCount)
				.u32(property.childOffset!)
				.u32(property.childCounters![0])
				.u32(property.childCounters![1])
				.u32(property.childCounters![2]);
		}

		// `findProperty` answers with the last property carrying an identifier,
		// and a later record replaces an earlier one, so writing them in order
		// leaves exactly that one reachable.
		this.store.set(
			this.#key.reset(this.tagBase + Tag.property).u32(slot).u32(property.rawId & 0x7fffffff).done(),
			this.#value.done());
	}
}

/**
 * One property set, addressed by property identifier.
 *
 * A view holds three numbers and two ranges. Asking it for a property is a
 * store lookup; asking that property for its bytes is a chunked read of the
 * section. Neither grows with the set.
 */
export class PropertySetView {
	readonly slot: number;
	/** The object data this set lives in, which every offset is relative to. */
	readonly value: ByteRange;
	readonly ids: CompactIds;
	/** @internal */
	readonly streams: Streams;

	readonly #owner: PropertyStore;

	constructor(owner: PropertyStore, slot: number, value: ByteRange, ids: CompactIds, streams: Streams) {
		this.#owner = owner;
		this.slot = slot;
		this.value = value;
		this.ids = ids;
		this.streams = streams;
	}

	get window(): ByteWindow {
		return this.#owner.window;
	}

	find(propertyId: number): PropertyRef | undefined {
		return this.#owner.lookup(this.slot, propertyId);
	}

	/** A nested set held by a property-set or property-set-array value. */
	childAt(property: PropertyRef, position: number): PropertySetView {
		return this.#owner.childView(this, property, position);
	}

	/**
	 * The identifiers a property names, resolved one at a time.
	 *
	 * The CompactIDs are read from the stream at a computed offset, so this
	 * costs four bytes per identifier however long the stream is.
	 */
	*references(property: PropertyRef | undefined): IterableIterator<ResolvedId> {
		for (let index = 0; index < (property?.referenceCount ?? 0); index++) {
			yield this.referenceAt(property!, index)!;
		}
	}

	/**
	 * The nth identifier a property names.
	 *
	 * Positional, because a caller that wants the fifth text run's formatting
	 * should not have to build the first four to get at it — and because a walk
	 * that indexes rather than iterates never holds a level's children.
	 */
	referenceAt(property: PropertyRef | undefined, index: number): ResolvedId | undefined {
		if (!property?.referenceCount || index < 0 || index >= property.referenceCount) return undefined;

		const field = (['object', 'objectSpace', 'context'] as const)[property.referenceKind!];
		const stream = this.streams[field]!;
		const at = (property.referenceStart! + index) * 4;
		const compact = new RangeReader(this.window, stream).u32(at);
		const identifier = this.ids.identifier(compact >>> 8);

		if (identifier === undefined) {
			throw new OneNoteFormatError('ONENOTE_COMPACT_ID',
				'A property reference uses a missing global-identification table entry.',
				stream.offset + at);
		}

		return { identifier, value: compact & 0xff };
	}
}
