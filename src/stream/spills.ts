/**
 * The scratch space one section's conversion uses.
 *
 * Each of these is a region of the same store, and each has one owner and one
 * lifetime — a paragraph's line buffer lasts a line, a page's ink lasts a page.
 * Naming them together makes the sharing explicit: two things that could be
 * live at the same moment must not be handed the same region, and having them
 * in one place is what makes that checkable rather than hoped for.
 */
import { PagedKeyValueStore } from '../storage/paged-key-value-store';
import { ByteSpool, DEFAULT_CHUNK_BYTES, RecordSpool } from '../storage/spool';
import { DEFAULT_SPILL_BUDGET, TextSpill } from './text';

const Tag = {
	noteTrailing: 60,
	paragraphTrailing: 61,
	line: 62,
	inkPoints: 63,
	inkStrokes: 64,
	inkDocument: 65,
	recognized: 66,
	titleInkPoints: 67,
	titleInkStrokes: 68,
	runWhitespace: 69,
	inkCoordinates: 70,
} as const;

/** One spooled ink point: two coordinates and a width, as float64s. */
const POINT_BYTES = 16;

/** One spooled ink coordinate, as a float64. */
const COORDINATE_BYTES = 8;

export class SpillSet {
	/** Whitespace held back by the note-level trim. */
	readonly trailing: TextSpill;
	/** Whitespace held back by a paragraph's trim. */
	readonly paragraph: TextSpill;
	/** One line of a paragraph, until its opening has been decided. */
	readonly line: TextSpill;
	/**
	 * The whitespace one text run opens or closes with.
	 *
	 * A run's emphasis markers go inside its whitespace, so the whitespace has
	 * to be held until it is known whether a core follows it. One region does
	 * for both ends: a run cannot be accumulating its leading whitespace and
	 * its trailing whitespace at once, because reaching the second means the
	 * first has already been written out.
	 */
	readonly runWhitespace: TextSpill;

	readonly inkPoints: ByteSpool;
	readonly inkStrokes: RecordSpool;
	/** The generated SVG, hashed from here and copied from here. */
	readonly inkDocument: ByteSpool;
	/** Recognized handwriting, joined into one block at the end of a page. */
	readonly recognized: ByteSpool;

	/**
	 * Ink met while working out a page's title.
	 *
	 * The eager mapper decodes the title's elements and throws them away, so
	 * ink in a title contributes its recognized words to the title and its
	 * strokes to nothing. Decoding it somewhere separate is what keeps those
	 * strokes out of the page's drawing.
	 */
	readonly titleInkPoints: ByteSpool;
	readonly titleInkStrokes: RecordSpool;

	/**
	 * One stroke's coordinates along whichever axis comes first in its path.
	 *
	 * An ink path stores its dimensions in blocks — every x, then every y — so
	 * pairing them means having seen both, and the whole first block has to be
	 * somewhere while the second is being read. Here, rather than in an array:
	 * the block is as long as the file claims.
	 *
	 * Lasts one stroke. Reset at the start of each, so a page of ten thousand
	 * strokes costs what one stroke costs.
	 */
	readonly inkCoordinates: ByteSpool;

	constructor(
		store: PagedKeyValueStore,
		budget = DEFAULT_SPILL_BUDGET,
		chunkBytes = DEFAULT_CHUNK_BYTES,
	) {
		// Ink points are sixteen bytes each, so the chunk is rounded down to a
		// whole number of them however small the budget made it.
		const pointChunk = Math.max(POINT_BYTES, Math.floor(chunkBytes / POINT_BYTES) * POINT_BYTES);
		// Likewise for single coordinates, so a float64 never straddles a chunk
		// and reading them back is a walk rather than a reassembly.
		const coordinateChunk = Math.max(
			COORDINATE_BYTES, Math.floor(chunkBytes / COORDINATE_BYTES) * COORDINATE_BYTES);

		this.trailing = new TextSpill(new ByteSpool(store, Tag.noteTrailing, 0, chunkBytes), budget);
		this.paragraph = new TextSpill(new ByteSpool(store, Tag.paragraphTrailing, 0, chunkBytes), budget);
		this.line = new TextSpill(new ByteSpool(store, Tag.line, 0, chunkBytes), budget);
		this.runWhitespace = new TextSpill(new ByteSpool(store, Tag.runWhitespace, 0, chunkBytes), budget);
		this.inkPoints = new ByteSpool(store, Tag.inkPoints, 0, pointChunk);
		this.inkStrokes = new RecordSpool(store, Tag.inkStrokes, 0);
		this.inkDocument = new ByteSpool(store, Tag.inkDocument, 0, chunkBytes);
		this.recognized = new ByteSpool(store, Tag.recognized, 0, chunkBytes);
		this.titleInkPoints = new ByteSpool(store, Tag.titleInkPoints, 0, pointChunk);
		this.titleInkStrokes = new RecordSpool(store, Tag.titleInkStrokes, 0);
		this.inkCoordinates = new ByteSpool(store, Tag.inkCoordinates, 0, coordinateChunk);
	}

	/** Between notes: nothing survives a page boundary. */
	resetForNote(): void {
		this.trailing.clear();
		this.paragraph.clear();
		this.line.clear();
		this.runWhitespace.clear();
		this.inkPoints.reset();
		this.inkStrokes.reset();
		this.inkDocument.reset();
		this.recognized.reset();
		this.titleInkPoints.reset();
		this.titleInkStrokes.reset();
		this.inkCoordinates.reset();
	}
}
