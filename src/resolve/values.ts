/**
 * The typed reads the semantic layer makes, against a lazy set.
 *
 * These are the counterparts of `semantic/properties.ts`, one for one and with
 * the same names, so a reader written against that module transfers by
 * changing what it is handed. The rules they encode — trailing NULs, the
 * FILETIME epoch, a float that is only a float if it is four bytes long — are
 * the same rules, because output has to be identical.
 *
 * The difference is in the return types, and it is the whole point. A value
 * that is a number comes back as a number; a value that is text comes back as
 * a range, and is decoded by whoever is in a position to consume it in pieces.
 * `readString` is kept for the values that genuinely have to become strings —
 * a file name, a URL, a style identifier — and is the only place here that
 * allocates in proportion to a property.
 */
import { overValueLimit, ValueMeter } from '../stream/limits';
import { ByteRange } from '../storage/byte-source';
import { asciiLength, asciiText, RangeReader, utf16Length, utf16Text } from './range-reader';
import { PropertyRef, PropertySetView, ResolvedId } from './property-view';

export function findProperty(view: PropertySetView | undefined, propertyId: number): PropertyRef | undefined {
	return view?.find(propertyId);
}

/** Where a value's bytes are, for a caller that will read them in pieces. */
export function dataRange(view: PropertySetView | undefined, propertyId: number): ByteRange | undefined {
	return view?.find(propertyId)?.data;
}

export function readBoolean(view: PropertySetView | undefined, propertyId: number): boolean | undefined {
	return view?.find(propertyId)?.booleanValue;
}

export function readUInt32Property(view: PropertySetView | undefined, propertyId: number): number | undefined {
	const value = view?.find(propertyId)?.scalarValue;
	return value === undefined ? undefined : value >>> 0;
}

export function readFloat(view: PropertySetView | undefined, propertyId: number): number | undefined {
	const range = dataRange(view, propertyId);
	if (!range || range.length !== 4) return undefined;

	const bytes = view!.window.peek(range.offset, 4);
	return new DataView(bytes.buffer, bytes.byteOffset, 4).getFloat32(0, true);
}

/** A Windows FILETIME, which counts 100ns ticks from 1601. */
export function readFileTime(view: PropertySetView | undefined, propertyId: number): Date | undefined {
	const value = view?.find(propertyId)?.scalarValue;
	if (value === undefined || value === 0) return undefined;

	const milliseconds = value / 10000 - 11644473600000;
	return Number.isFinite(milliseconds) ? new Date(milliseconds) : undefined;
}

/** Seconds from 1980-01-01. */
export function readTime32(view: PropertySetView | undefined, propertyId: number): Date | undefined {
	const value = readUInt32Property(view, propertyId);
	return value === undefined ? undefined : new Date(Date.UTC(1980, 0, 1) + value * 1000);
}

/** The values of a uint32 array property, one at a time. */
export function* readUInt32Array(view: PropertySetView | undefined, propertyId: number): IterableIterator<number> {
	const range = dataRange(view, propertyId);
	if (!range || range.length % 4 !== 0) return;

	const reader = new RangeReader(view!.window, range);
	for (let offset = 0; offset < range.length; offset += 4) yield reader.u32(offset);
}

/**
 * A uint32 array property, addressed rather than listed.
 *
 * Run boundaries are the case that matters: there is one per run, a paragraph
 * may have many, and the render visits them in order but needs the count up
 * front. Indexing gives both without the array.
 */
export interface Uint32Values {
	readonly count: number;
	at(index: number): number;
}

export const NO_UINT32_VALUES: Uint32Values = {
	count: 0,
	at: () => { throw new RangeError('No values to read.'); },
};

export function uint32Values(view: PropertySetView | undefined, propertyId: number): Uint32Values {
	const range = dataRange(view, propertyId);
	if (!range || range.length % 4 !== 0 || range.length === 0) return NO_UINT32_VALUES;

	const reader = new RangeReader(view!.window, range);
	return { count: range.length >>> 2, at: index => reader.u32(index * 4) };
}

export function* references(
	view: PropertySetView | undefined,
	propertyId: number,
): IterableIterator<ResolvedId> {
	if (!view) return;
	yield* view.references(view.find(propertyId));
}

/** The first identifier a property names, which is often all a caller wants. */
export function firstReference(view: PropertySetView | undefined, propertyId: number): ResolvedId | undefined {
	for (const id of references(view, propertyId)) return id;
	return undefined;
}

function trimTrailingNulls(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 0) end--;
	return value.slice(0, end);
}

/**
 * A UTF-16LE value as a string, up to a ceiling.
 *
 * For the values that have to be one: a file name, a hyperlink target, a style
 * identifier, a page title. Each is short by nature, and the cost is that
 * property's length rather than the section's — but it is a real cost, so
 * nothing that could be a note's body should come through here.
 *
 * The ceiling is checked before anything is decoded, because the length is
 * arithmetic on the range: a property claiming a hundred megabytes of title
 * fails without allocating a hundred megabytes to find out. `describe` names
 * the value in the failure, since the caller knows what it was asking for and
 * this does not.
 */
export function readString(
	view: PropertySetView | undefined,
	propertyId: number,
	limit = Infinity,
	describe = 'A metadata value',
	meter?: ValueMeter,
): string | undefined {
	const range = dataRange(view, propertyId);
	if (!range || range.length === 0) return undefined;

	const units = range.length >>> 1;
	if (units > limit) throw overValueLimit(describe, units, limit, 'maxValueChars');
	meter?.value(units);

	let value = '';
	for (const piece of utf16Text(view!.window, range, 0, units)) value += piece;
	return trimTrailingNulls(value);
}

/** The single-byte form, one character per byte as its reader has it. */
export function readSingleByteString(
	view: PropertySetView | undefined,
	propertyId: number,
	limit = Infinity,
	describe = 'A metadata value',
	meter?: ValueMeter,
): string | undefined {
	const range = dataRange(view, propertyId);
	if (!range || range.length === 0) return undefined;

	if (range.length > limit) throw overValueLimit(describe, range.length, limit, 'maxValueChars');
	meter?.value(range.length);

	let value = '';
	for (const piece of asciiText(view!.window, range, 0, range.length)) value += piece;
	return trimTrailingNulls(value);
}

/**
 * How a paragraph's text is stored, and how long it is.
 *
 * A rich-text node keeps its text in one of two encodings, and the run
 * boundaries beside it are indices into whichever one is present — after
 * trailing NULs have gone. Resolving that much without decoding a character is
 * what lets a run be rendered straight out of the file.
 */
export interface TextSource {
	range: ByteRange;
	encoding: 'utf-16' | 'single-byte';
	/** Length in the units the run boundaries count in. */
	length: number;
}

export function textSource(
	view: PropertySetView | undefined,
	utf16PropertyId: number,
	singleBytePropertyId: number,
): TextSource | undefined {
	const wide = dataRange(view, utf16PropertyId);
	if (wide && wide.length > 0) {
		return { range: wide, encoding: 'utf-16', length: utf16Length(view!.window, wide) };
	}

	const narrow = dataRange(view, singleBytePropertyId);
	if (narrow && narrow.length > 0) {
		return { range: narrow, encoding: 'single-byte', length: asciiLength(view!.window, narrow) };
	}

	return undefined;
}

/** A half-open slice of a text source, in pieces. */
export function* textSlice(
	view: PropertySetView,
	source: TextSource,
	start: number,
	end: number,
): IterableIterator<string> {
	if (source.encoding === 'utf-16') yield* utf16Text(view.window, source.range, start, end);
	else yield* asciiText(view.window, source.range, start, end);
}
