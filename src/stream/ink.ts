/**
 * Ink, held on disk between the page that draws it and the file it becomes.
 *
 * An ink drawing is the one thing on a page that cannot be written where it is
 * met. Strokes arrive scattered through the content — some inside table cells —
 * and they all become a single SVG appended at the end, whose viewBox depends
 * on the extent of every stroke in it. So something has to survive the walk.
 *
 * What survives here is the points, in the store, and a bounding box computed
 * as they go past. The SVG is then generated from them straight into a spool,
 * which is what the attachment writer hashes and copies — so the drawing exists
 * as bytes on disk and as one chunk in memory, never as a string.
 *
 * `strokesToSvg` is the shape being reproduced, down to how a number is
 * formatted: a coordinate reaches the file as JavaScript's own rendering of a
 * double, so the points are stored as doubles and the arithmetic is left in the
 * same order.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { RangeReader } from '../resolve/range-reader';
import { ByteSpool, RecordSpool } from '../storage/spool';
import { RecordReader, RecordWriter } from '../storage/records';

const PADDING = 10;

/** Sixteen bytes a point, so a chunk boundary never falls inside one. */
const POINT_BYTES = 16;

/** Eight bytes a coordinate, for the same reason. */
const COORDINATE_BYTES = 8;

/**
 * A forward walk over an ink path's bytes, one variable-width integer at a time.
 *
 * An ink path is a run of variable-width integers, and the eager reader copies
 * the whole run out of the file before decoding any of it. That is the one
 * unbounded read left in the conversion: the run is as long as the property
 * says, a page of dense handwriting is hundreds of kilobytes of it, and a
 * hostile file can claim more than the read window is even able to hold — which
 * turned a large drawing into a window error rather than a drawing.
 *
 * So the bytes are pulled a step at a time instead. A step is a view into the
 * read window, valid only until the next one, which is why the byte is taken
 * and the view is not kept. An integer straddling a step boundary is ordinary
 * here rather than a special case: the refill happens between two bytes of it
 * and neither byte cares.
 */
class InkPathCursor {
	readonly #reader: RangeReader;
	/**
	 * One buffer, filled again for each step.
	 *
	 * A copy rather than a view into the read window, and reused rather than
	 * allocated per step. The window's own buffer would do — nothing between
	 * two refills here touches it — but that is true by inspection of the
	 * loop below rather than by construction, and a window read added to the
	 * point handler one day would corrupt the path being decoded without
	 * anything to say so. One buffer for the cursor's lifetime costs a chunk,
	 * which the budget names, and cannot be aliased by anyone.
	 */
	readonly #buffer: Uint8Array;

	/** Bytes of `#buffer` that are filled. */
	#filled = 0;
	/** Where `#buffer` starts, as an offset into the range. */
	#chunkAt = 0;
	/** How far the walk has got, as an offset into the range. */
	#at = 0;

	constructor(reader: RangeReader, stepBytes: number) {
		this.#reader = reader;
		this.#buffer = new Uint8Array(
			Math.max(1, Math.min(stepBytes, reader.window.capacity)));
	}

	/** Whether the walk has reached the end of the path. */
	get exhausted(): boolean {
		return this.#at >= this.#reader.length;
	}

	/**
	 * The next integer, decoded exactly as the eager reader decodes it.
	 *
	 * Including the failures: the same three conditions produce the same three
	 * codes, because a file that was malformed before must still be malformed.
	 */
	varUInt(): number {
		let value = 0;
		let shift = 1;

		for (let index = 0; index < 10; index++) {
			if (this.exhausted) {
				throw new OneNoteFormatError(
					'ONENOTE_INK_VARINT', 'The ink path contains a truncated multi-byte integer.');
			}

			const current = this.#next();
			value += (current & 0x7f) * shift;
			if ((current & 0x80) === 0) return value;

			shift *= 128;
			if (shift > Number.MAX_SAFE_INTEGER) {
				throw new OneNoteFormatError(
					'ONENOTE_INK_VARINT', 'The ink path contains a multi-byte integer wider than supported.');
			}
		}

		throw new OneNoteFormatError(
			'ONENOTE_INK_VARINT', 'The ink path contains an invalid multi-byte integer.');
	}

	#next(): number {
		if (this.#at >= this.#chunkAt + this.#filled) {
			const take = Math.min(this.#buffer.byteLength, this.#reader.length - this.#at);
			this.#buffer.set(this.#reader.peek(this.#at, take));
			this.#filled = take;
			this.#chunkAt = this.#at;
		}

		return this.#buffer[this.#at++ - this.#chunkAt];
	}
}

/**
 * One stroke's coordinates, decoded from the path without holding the path.
 *
 * The path stores its dimensions one whole block at a time — every x, then
 * every y — so a point is two numbers that are thousands of integers apart in
 * the stream. Pairing them needs the first block kept somewhere while the
 * second is read, and the block is as long as the file says it is.
 *
 * So the first block goes to a spool and the second is paired against it as it
 * arrives, which makes the whole thing one forward pass over the path with two
 * chunk buffers live: the cursor's step and the spool's. The delta sums are
 * accumulated in the order the eager reader accumulates them, because the
 * result is a double and a double reaches the file as its own decimal
 * rendering — a reassociated sum would print differently.
 *
 * `emit` is handed each pair. It returns nothing, and the points it is given
 * are the points `decodePacketValues` would have produced at the same indices.
 */
export function decodeInkPath(
	reader: RangeReader,
	stepBytes: number,
	spool: ByteSpool,
	dimensionCount: number,
	xIndex: number,
	yIndex: number,
	maximumValues: number,
	emit: (x: number, y: number) => void,
): boolean {
	if (reader.length === 0) return false;

	const cursor = new InkPathCursor(reader, stepBytes);
	const count = Math.floor(cursor.varUInt() / 2);

	if (count > maximumValues) {
		throw new OneNoteFormatError(
			'ONENOTE_INK_PATH_LIMIT', 'The ink path exceeds the configured property value limit.');
	}

	if (count === 0) return false;

	// Whether the count divides into whole points is not known until it has
	// been read, and the eager reader decodes everything before it checks — so
	// a path that does not divide still has to be walked to the end, because
	// walking it is what discovers that it was also truncated. That failure
	// takes precedence, so it has to be found the same way.
	const divides = count % dimensionCount === 0;
	const pointCount = divides ? count / dimensionCount : 0;

	// Blocks in the order they appear, not in x-then-y order: which axis is
	// stored first is the file's choice.
	const firstBlock = Math.min(xIndex, yIndex) * pointCount;
	const secondBlock = Math.max(xIndex, yIndex) * pointCount;
	const firstIsX = xIndex <= yIndex;

	spool.reset();

	const scratch = new Uint8Array(COORDINATE_BYTES);
	const scratchView = new DataView(scratch.buffer);

	let firstSum = 0;
	let secondSum = 0;
	let paired = 0;
	let cursorInto: SpoolCoordinates | undefined;

	for (let index = 0; index < count; index++) {
		if (cursor.exhausted) {
			throw new OneNoteFormatError(
				'ONENOTE_INK_PATH_TRUNCATED',
				'The ink path ends before all declared coordinates were decoded.');
		}

		const encoded = cursor.varUInt();
		const magnitude = Math.floor(encoded / 2);
		const value = (encoded & 1) === 0 ? magnitude : -magnitude;

		if (!divides) continue;

		if (index >= firstBlock && index < firstBlock + pointCount) {
			firstSum = index === firstBlock ? value : firstSum + value;

			// Both axes reading the same block means the file named one
			// dimension twice; the eager reader hands that block to both
			// prefix sums, so the point is the coordinate against itself.
			if (firstBlock === secondBlock) emit(firstSum, firstSum);
			else {
				scratchView.setFloat64(0, firstSum, true);
				spool.write(scratch);
			}

			continue;
		}

		if (index >= secondBlock && index < secondBlock + pointCount) {
			secondSum = index === secondBlock ? value : secondSum + value;

			cursorInto ??= new SpoolCoordinates(spool);
			const other = cursorInto.next();
			emit(firstIsX ? other : secondSum, firstIsX ? secondSum : other);
			paired++;
		}
	}

	if (!divides) return false;

	// A path whose blocks did not overlap the way the arithmetic assumed would
	// otherwise emit a short stroke and say nothing about it.
	if (firstBlock !== secondBlock && paired !== pointCount) {
		throw new OneNoteFormatError(
			'ONENOTE_INK_PATH_TRUNCATED',
			`The ink path paired ${paired} of ${pointCount} points.`);
	}

	return true;
}

/**
 * A sequential read of float64s out of a spool.
 *
 * Chunk sizes are whole multiples of eight, so a coordinate never straddles a
 * boundary and this is a walk rather than a reassembly. The chunk it holds is
 * a copy the store handed over, so writing to a different region of the same
 * store while reading here is safe.
 */
class SpoolCoordinates {
	readonly #chunks: Iterator<Uint8Array>;

	#view: DataView | undefined;
	#at = 0;

	constructor(spool: ByteSpool) {
		this.#chunks = spool.chunks();
	}

	next(): number {
		if (!this.#view || this.#at >= this.#view.byteLength) {
			const step = this.#chunks.next();
			if (step.done) {
				throw new OneNoteFormatError(
					'ONENOTE_INK_PATH_TRUNCATED',
					'The ink path has more coordinates on one axis than the other.');
			}

			this.#view = new DataView(step.value.buffer, step.value.byteOffset, step.value.byteLength);
			this.#at = 0;
		}

		const value = this.#view.getFloat64(this.#at, true);
		this.#at += COORDINATE_BYTES;
		return value;
	}
}

export interface SpooledStroke {
	color: string;
	width: number;
	opacity: number;
	firstPoint: number;
	pointCount: number;
}

/**
 * The strokes of one page.
 *
 * Points go into a byte spool and strokes into a record spool, which keeps the
 * per-point cost to sixteen bytes rather than a record header each.
 */
export class StrokeCollector {
	minX = Infinity;
	minY = Infinity;
	maxX = -Infinity;
	maxY = -Infinity;

	readonly #points: ByteSpool;
	readonly #strokes: RecordSpool;
	readonly #point = new Uint8Array(POINT_BYTES);
	readonly #pointView: DataView;
	readonly #record = new RecordWriter(64);

	#pointCount = 0;
	#drawable = 0;

	constructor(points: ByteSpool, strokes: RecordSpool) {
		this.#points = points;
		this.#strokes = strokes;
		this.#pointView = new DataView(this.#point.buffer);
	}

	/** Strokes with at least one point, which are the ones that are drawn. */
	get drawableCount(): number {
		return this.#drawable;
	}

	get strokeCount(): number {
		return this.#strokes.count;
	}

	/**
	 * Begin a stroke. Points are pushed after it, then `endStroke` closes it.
	 *
	 * Kept open rather than taking an array because the points come out of a
	 * delta-decoder one at a time and collecting them first would be the
	 * allocation this avoids.
	 */
	beginStroke(): number {
		return this.#pointCount;
	}

	pushPoint(x: number, y: number): void {
		this.#pointView.setFloat64(0, x, true);
		this.#pointView.setFloat64(8, y, true);
		this.#points.write(this.#point);
		this.#pointCount++;

		if (x < this.minX) this.minX = x;
		if (y < this.minY) this.minY = y;
		if (x > this.maxX) this.maxX = x;
		if (y > this.maxY) this.maxY = y;
	}

	endStroke(firstPoint: number, color: string, width: number, opacity: number): void {
		const pointCount = this.#pointCount - firstPoint;
		if (pointCount > 0) this.#drawable++;

		this.#strokes.push(this.#record.reset()
			.text(color)
			.f64(width)
			.f64(opacity)
			.u32(firstPoint)
			.u32(pointCount)
			.done());
	}

	strokeAt(position: number): SpooledStroke {
		const reader = new RecordReader(this.#strokes.at(position));
		return {
			color: reader.text(),
			width: reader.f64(),
			opacity: reader.f64(),
			firstPoint: reader.u32(),
			pointCount: reader.u32(),
		};
	}

	/**
	 * The points of one stroke, read back in order.
	 *
	 * The spool is a byte stream, so a point can straddle a chunk boundary in
	 * principle; the leftover is carried rather than assumed away.
	 */
	*pointsOf(stroke: SpooledStroke): IterableIterator<{ x: number, y: number }> {
		if (stroke.pointCount === 0) return;

		const start = stroke.firstPoint * POINT_BYTES;
		const end = start + stroke.pointCount * POINT_BYTES;
		const carry = new Uint8Array(POINT_BYTES);
		const carryView = new DataView(carry.buffer);

		let position = 0;
		let held = 0;

		for (const chunk of this.#points.chunks()) {
			const chunkEnd = position + chunk.byteLength;
			if (chunkEnd <= start) {
				position = chunkEnd;
				continue;
			}
			if (position >= end) break;

			const from = Math.max(0, start - position);
			const to = Math.min(chunk.byteLength, end - position);

			for (let at = from; at < to; at++) {
				carry[held++] = chunk[at];
				if (held < POINT_BYTES) continue;
				held = 0;
				yield { x: carryView.getFloat64(0, true), y: carryView.getFloat64(8, true) };
			}

			position = chunkEnd;
		}
	}

	reset(): void {
		this.#points.reset();
		this.#strokes.reset();
		this.#pointCount = 0;
		this.#drawable = 0;
		this.minX = Infinity;
		this.minY = Infinity;
		this.maxX = -Infinity;
		this.maxY = -Infinity;
	}
}

/**
 * Render the collected strokes into `into`, or answer false if there are none.
 *
 * This is `strokesToSvg` with the string concatenation replaced by writes. The
 * order of the arithmetic is preserved because the results are formatted into
 * the document: `x - minX + PADDING` and `x + (PADDING - minX)` do not always
 * produce the same double, and the difference would show up in the output.
 */
export function writeInkSvg(strokes: StrokeCollector, into: ByteSpool): boolean {
	if (strokes.drawableCount === 0) return false;

	const { minX, minY, maxX, maxY } = strokes;
	const width = maxX - minX + PADDING * 2;
	const height = maxY - minY + PADDING * 2;

	into.reset();
	into.writeText(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);

	let written = 0;

	for (let position = 0; position < strokes.strokeCount; position++) {
		const stroke = strokes.strokeAt(position);
		if (stroke.pointCount === 0) continue;

		if (written > 0) into.writeText('\n');
		written++;

		const opacityAttr = stroke.opacity < 1 ? ` opacity="${stroke.opacity.toFixed(2)}"` : '';

		if (stroke.pointCount === 1) {
			for (const { x, y } of strokes.pointsOf(stroke)) {
				into.writeText(
					`<circle cx="${x - minX + PADDING}" cy="${y - minY + PADDING}" r="${stroke.width / 2}" fill="${stroke.color}"${opacityAttr}/>`);
			}
			continue;
		}

		into.writeText('<path d="');
		let index = 0;
		for (const { x, y } of strokes.pointsOf(stroke)) {
			into.writeText(`${index === 0 ? 'M' : ' L'} ${x - minX + PADDING} ${y - minY + PADDING}`);
			index++;
		}
		into.writeText(
			`" stroke="${stroke.color}" stroke-width="${stroke.width}" fill="none" stroke-linecap="round" stroke-linejoin="round"${opacityAttr}/>`);
	}

	into.writeText('</svg>');
	return true;
}

/** Bytes a dimension record occupies: a GUID, then a lower and upper bound. */
const DIMENSION_BYTES = 32;

/**
 * Which axis is which, and how many axes there are, read a record at a time.
 *
 * The eager reader copies the whole dimension table out of the file and builds
 * an array of records, of which the conversion uses three things: how many
 * there are, and where x and y sit among them. The bounds are read and thrown
 * away, and the identifiers are read to be compared against two constants.
 *
 * A stroke has two or three dimensions, so the table is ninety-six bytes in
 * every file OneNote wrote. But its length comes from the property, and a file
 * can claim whatever it likes — which previously meant either a large
 * allocation or a limit invented to forbid one. Neither was necessary: nothing
 * here needs two records at once. So the table is walked one thirty-two byte
 * record at a time and only the two indexes come back, which is a fixed cost
 * for any table a file can describe and needs no ceiling to say so.
 *
 * Reproduces `decodeDimensions` followed by two `indexOfDimension` calls,
 * including that a trailing partial record is ignored rather than rejected —
 * the eager loop advances while a whole record remains and stops otherwise.
 */
export function readInkDimensions(
	reader: RangeReader | undefined,
	xId: string,
	yId: string,
): { count: number, xIndex: number, yIndex: number } {
	if (!reader || reader.length === 0) return { count: 0, xIndex: -1, yIndex: -1 };

	const count = Math.floor(reader.length / DIMENSION_BYTES);
	let xIndex = -1;
	let yIndex = -1;

	for (let index = 0; index < count; index++) {
		// `findIndex` answers with the first match, so a table naming an axis
		// twice resolves to the earlier record. Hence the guards.
		if (xIndex >= 0 && yIndex >= 0) break;

		const id = readDimensionId(reader, index * DIMENSION_BYTES);
		if (xIndex < 0 && id === xId) xIndex = index;
		if (yIndex < 0 && id === yId) yIndex = index;
	}

	return { count, xIndex, yIndex };
}

/**
 * A dimension record's GUID, in the mixed-endian spelling the format uses.
 *
 * The same bytes in the same order as `readGuid`, peeked rather than copied:
 * sixteen bytes is inside any window, and the string is the only thing kept.
 */
function readDimensionId(reader: RangeReader, offset: number): string {
	const bytes = reader.peek(offset, 16);
	const hex = (index: number) => bytes[index].toString(16).padStart(2, '0');

	return [
		hex(3) + hex(2) + hex(1) + hex(0),
		hex(5) + hex(4),
		hex(7) + hex(6),
		hex(8) + hex(9),
		hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15),
	].join('-');
}
