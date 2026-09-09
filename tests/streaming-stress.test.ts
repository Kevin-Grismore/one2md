/**
 * The bounded machinery at sizes the fixtures do not reach.
 *
 * Every fixture here is a few hundred kilobytes, so none of them makes a text
 * spill spill, a stroke spool span chunks, or an attachment exceed the copy
 * buffer. The parity tests therefore prove the transliteration is faithful
 * without proving it stays faithful once the state it holds has to go to disk —
 * which is the case the whole design exists for.
 *
 * So these drive the same components with constructed input large enough to
 * cross those boundaries, and check them against the string and array versions
 * they replace. Where the original is a regular expression or a `replace`
 * chain, the original is the oracle: it is run on the whole input and the
 * streamed result has to equal it exactly.
 */
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { strokesToSvg, SvgStroke } from '../src/onenote-file/ink-svg';
import { InkDimensionId, decodeDimensions, decodePacketValues, decodeSignedVector, indexOfDimension } from '../src/onenote-file/semantic/ink';
import { RangeReader } from '../src/resolve/range-reader';
import { Uint8ArrayByteSource } from '../src/storage/byte-source';
import { ByteWindow } from '../src/storage/byte-window';
import { PagedKeyValueStore } from '../src/storage/paged-key-value-store';
import { ByteSpool, RecordSpool } from '../src/storage/spool';
import { AssetWriter, ByteStream } from '../src/stream/assets';
import { StrokeCollector, decodeInkPath, readInkDimensions, writeInkSvg } from '../src/stream/ink';
import { joinBounded, ValueMeter } from '../src/stream/limits';
import { NoteWriter } from '../src/stream/markdown';
import { ChunkWriter } from '../src/stream/sink';
import {
	CarriageReturnFilter,
	decideLineStart,
	NewlineCollapser,
	TextSpill,
	Trimmer,
} from '../src/stream/text';
import { StreamWorkspace } from '../src/stream/workspace';

const SOURCE_ROOT = nodePath.resolve(
	nodePath.dirname(fileURLToPath(import.meta.url)), '..');

/** A deterministic generator, so a failure is reproducible. */
function random(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function withStore<T>(body: (store: PagedKeyValueStore) => T): T {
	const store = new PagedKeyValueStore({ pageSize: 8192, cacheBytes: 128 * 1024 });
	try {
		return body(store);
	}
	finally {
		store.close();
	}
}

async function withStoreAsync(body: (store: PagedKeyValueStore) => Promise<void>): Promise<void> {
	const store = new PagedKeyValueStore({ pageSize: 8192, cacheBytes: 128 * 1024 });
	try {
		await body(store);
	}
	finally {
		store.close();
	}
}

/** Feeds text through a chain in awkward pieces, as a real render does. */
function* slices(text: string, next: () => number): IterableIterator<string> {
	let at = 0;
	while (at < text.length) {
		const take = 1 + Math.floor(next() * 40);
		yield text.slice(at, at + take);
		at += take;
	}
}

// -- Text ------------------------------------------------------------------

test('the text chain equals the string chain on a megabyte of awkward text', async () => {
	const next = random(20260908);
	const alphabet = [
		'a', ' ', '\n', '\r', '\r\n', '\t', 'ü', '  ', '\n\n', '\n\n\n\n', '\u00a0',
		// Long enough to push the trimmer's held run past its budget, which is
		// the case a note padded with blank space actually produces.
		' '.repeat(300),
	];

	let source = '';
	while (source.length < 1024 * 1024) source += alphabet[Math.floor(next() * alphabet.length)];

	// What `renderRuns` and `PageWriter.markdown` do, in that order.
	const expected = source
		.replace(/\r\n?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();

	await withStoreAsync(async store => {
		const spill = new TextSpill(new ByteSpool(store, 1, 0), 64);

		let produced = '';
		const trimmer = new Trimmer(piece => void (produced += piece), spill);
		const collapser = new NewlineCollapser(piece => trimmer.push(piece));
		const returns = new CarriageReturnFilter(piece => collapser.push(piece));

		// Checked as it goes, because `finish` clears the spill on its way out.
		let everSpilled = false;

		for (const piece of slices(source, next)) {
			await returns.push(piece);
			everSpilled ||= spill.spilled;
		}
		await returns.finish();
		await collapser.finish();
		await trimmer.finish();

		assert.equal(produced, expected);
		assert.ok(everSpilled, 'the trailing-whitespace spill never reached the store');
	});
});

test('a note ending in half a megabyte of whitespace trims without holding it', async () => {
	await withStoreAsync(async store => {
		const spool = new ByteSpool(store, 2, 0, 1024);
		const spill = new TextSpill(spool, 2048);

		let produced = '';
		const trimmer = new Trimmer(piece => void (produced += piece), spill);

		await trimmer.push('content');
		for (let index = 0; index < 512; index++) await trimmer.push(' '.repeat(1024));
		await trimmer.finish();

		assert.equal(produced, 'content');
		assert.ok(spool.residentBytes <= 1024,
			`the spool held ${spool.residentBytes} bytes for half a megabyte of whitespace`);
	});
});

test('the line-start decision agrees with the regular expression it replaces', async () => {
	const escapeLineStart = (line: string) =>
		line.replace(
			/^(\s*)(#{1,6}(?=\s|$)|>|\||[-*+](?=\s)|\d+[.)](?=\s)|`{3,}|~{3,}|-{3,}$|={3,}$)/,
			'$1\\$2');

	const next = random(7);
	const openings = [
		'', ' ', '\t', '   ', '#', '##', '#######', '>', '|', '-', '*', '+', '```', '~~~~',
		'---', '----', '===', '1.', '12)', '0.', '#\t', '- ', '-x', '=', '==', '\u00a0',
	];
	const tails = ['', ' text', 'text', ' ', '\t x', '-', '=', '.', ') more'];

	for (const opening of openings) {
		for (const tail of tails) {
			const line = opening + tail;
			const decision = decideLineStart(slices(line, next));
			const expected = escapeLineStart(line);

			const actual = decision.matched
				? `${line.slice(0, decision.whitespaceLength)}\\${line.slice(decision.whitespaceLength)}`
				: line;

			assert.equal(actual, expected, `line-start escaping differs for ${JSON.stringify(line)}`);
		}
	}

	// And on a line long enough that no implementation could be holding it by
	// accident: the answer depends only on the opening and on reaching the end.
	const long = `--- ${'x'.repeat(1024 * 1024)}`;
	assert.equal(decideLineStart(slices(long, next)).matched, escapeLineStart(long) !== long);
});

test('a note is written in chunks, and the chunks reassemble into the note', async () => {
	await withStoreAsync(async store => {
		const pieces: string[] = [];
		const target: ChunkWriter = {
			write: async chunk => void pieces.push(Buffer.from(chunk).toString('utf8')),
			close: async () => {},
		};

		const note = new NoteWriter(target, new TextSpill(new ByteSpool(store, 3, 0), 1024), 64);

		await note.raw('---\ntitle: "x"\n---\n');
		for (let index = 0; index < 2000; index++) {
			await note.beginBlock(true);
			await note.push(`- item ${index}`);
		}
		await note.finish();

		const items = Array.from({ length: 2000 }, (_, index) => `- item ${index}`);
		const expected = `---\ntitle: "x"\n---\n${items.join('\n')}\n`;

		assert.ok(pieces.length > 100, 'the note was written as one chunk');
		assert.equal(pieces.join(''), expected);
	});
});

// -- Blobs -----------------------------------------------------------------

/** A large attachment that is generated rather than held. */
function syntheticStream(length: number, chunkBytes = 64 * 1024): ByteStream {
	return {
		length,
		*chunks(): IterableIterator<Uint8Array> {
			const chunk = new Uint8Array(chunkBytes);
			for (let at = 0; at < length; at += chunkBytes) {
				const size = Math.min(chunkBytes, length - at);
				for (let index = 0; index < size; index++) chunk[index] = (at + index) & 0xff;
				yield chunk.subarray(0, size);
			}
		},
	};
}

test('a large attachment is copied through without being held', async () => {
	const length = 8 * 1024 * 1024;
	const stream = syntheticStream(length);

	let written = 0;
	let largestChunk = 0;
	let digest = 0;

	const sink = {
		write: async () => assert.fail('a chunked sink should not be asked for a whole file'),
		open: async () => ({
			write: async (chunk: Uint8Array) => {
				written += chunk.byteLength;
				largestChunk = Math.max(largestChunk, chunk.byteLength);
				for (const byte of chunk) digest = (digest + byte) & 0xffffff;
			},
			close: async () => {},
		}),
	};

	const workspace = new StreamWorkspace();
	try {
		const writer = new AssetWriter(sink, workspace, { writeAttachments: true });
		const saved = await writer.save(stream, 'big.bin', 'attachments', 'attachments');

		assert.ok(saved, 'the attachment was not written');
		assert.equal(written, length, 'the copy is not the length of the source');
		assert.ok(largestChunk <= 64 * 1024,
			`a ${largestChunk}-byte chunk reached the sink for a ${length}-byte attachment`);

		let expected = 0;
		for (let at = 0; at < length; at++) expected = (expected + (at & 0xff)) & 0xffffff;
		assert.equal(digest, expected, 'the copied bytes are not the source bytes');

		// The same bytes again are recognised without being written again.
		const again = await writer.save(stream, 'big.bin', 'attachments', 'attachments');
		assert.deepEqual(again, saved);
		assert.equal(written, length, 'identical bytes were written twice');
	}
	finally {
		workspace.close();
	}
});

test('a spool round-trips a large stream through chunk boundaries', () => {
	withStore(store => {
		const spool = new ByteSpool(store, 4, 0, 1024);
		const next = random(99);

		let expected = '';
		for (let index = 0; index < 20000; index++) {
			// Multi-byte characters, so a chunk boundary falls inside one.
			const piece = `${index}—ü\u{1f600}`;
			expected += piece;
			spool.writeText(piece);
		}

		let produced = '';
		for (const piece of spool.text()) produced += piece;
		assert.equal(produced, expected);

		// Re-readable, and the same the second time.
		produced = '';
		for (const piece of spool.text()) produced += piece;
		assert.equal(produced, expected);
		assert.ok(spool.residentBytes <= 1024, 'the spool grew with what was written');

		void next;
	});
});

test('a record spool holds a hundred thousand records outside heap', () => {
	withStore(store => {
		const spool = new RecordSpool(store, 5, 0);
		const record = new Uint8Array(24);

		for (let index = 0; index < 100_000; index++) {
			new DataView(record.buffer).setUint32(0, index, true);
			assert.equal(spool.push(record), index);
		}

		assert.equal(spool.count, 100_000);
		assert.equal(new DataView(spool.at(99_999).buffer, spool.at(99_999).byteOffset).getUint32(0, true),
			99_999);
	});
});

// -- Ink -------------------------------------------------------------------

test('a drawing with a hundred thousand points renders as the string version does', () => {
	withStore(store => {
		const next = random(4242);
		const collector = new StrokeCollector(
			new ByteSpool(store, 6, 0, 4096), new RecordSpool(store, 7, 0));

		const reference: SvgStroke[] = [];

		for (let stroke = 0; stroke < 200; stroke++) {
			const points: { x: number, y: number }[] = [];
			const count = 1 + Math.floor(next() * 500);

			const first = collector.beginStroke();
			for (let index = 0; index < count; index++) {
				const x = next() * 1000 - 500;
				const y = next() * 1000 - 500;
				points.push({ x, y });
				collector.pushPoint(x, y);
			}

			const color = `#${Math.floor(next() * 0xffffff).toString(16).padStart(6, '0')}`;
			const width = 1 + next() * 5;
			const opacity = next() < 0.5 ? 1 : next();

			collector.endStroke(first, color, width, opacity);
			reference.push({ points, color, width, opacity });
		}

		const document = new ByteSpool(store, 8, 0, 4096);
		assert.ok(writeInkSvg(collector, document), 'the drawing produced nothing');

		assert.equal(document.readAllText(), strokesToSvg(reference));
	});
});

test('an empty drawing produces nothing, as it does on the eager path', () => {
	withStore(store => {
		const collector = new StrokeCollector(
			new ByteSpool(store, 9, 0), new RecordSpool(store, 10, 0));

		// A stroke with no points is not drawn, and a drawing of them is not one.
		collector.endStroke(collector.beginStroke(), '#000000', 1, 1);

		assert.equal(writeInkSvg(collector, new ByteSpool(store, 11, 0)), false);
		assert.ok(!strokesToSvg([{ points: [], color: '#000000', width: 1, opacity: 1 }]));
	});
});

// -- Pages -----------------------------------------------------------------

/**
 * Claiming is quadratic in the number of pages that want one name, here and in
 * `NameRegistry` both: each claim probes ` 1`, ` 2`, … from the start. That is
 * the existing behaviour and moving it to disk does not change it, so the count
 * here is what the shape can bear rather than what a large notebook holds.
 */
test('the name registry hands out colliding names from disk, without repeating one', () => {
	const workspace = new StreamWorkspace();

	try {
		const seen = new Set<string>();
		for (let index = 0; index < 2000; index++) {
			const name = workspace.claim('notes', 'Page.md');
			assert.ok(!seen.has(name.toLowerCase()), `${name} was handed out twice`);
			seen.add(name.toLowerCase());
		}

		assert.equal(seen.size, 2000);
		assert.ok(workspace.isClaimed('notes', 'page.md'), 'claiming is not case-insensitive');
	}
	finally {
		workspace.close();
	}
});

test('distinct names are claimed at scale', () => {
	const workspace = new StreamWorkspace();

	try {
		for (let index = 0; index < 100_000; index++) {
			assert.equal(workspace.claim('notes', `Page ${index}.md`), `Page ${index}.md`);
		}

		assert.ok(workspace.isClaimed('notes', 'page 99999.md'));
		assert.ok(!workspace.isClaimed('notes', 'page 100000.md'));
	}
	finally {
		workspace.close();
	}
});

test('a report of a hundred thousand records is counted without being held', () => {
	const workspace = new StreamWorkspace();

	try {
		for (let index = 0; index < 100_000; index++) workspace.recordNote(`notes/page-${index}.md`);
		for (let index = 0; index < 1000; index++) {
			workspace.recordSkipped(`page-${index}`, `item-${index}`, 'no-data');
		}

		assert.equal(workspace.summary.noteCount, 100_000);
		assert.equal(workspace.summary.skippedCount, 1000);

		let last = '';
		let counted = 0;
		for (const note of workspace.notes()) {
			last = note;
			counted++;
		}

		assert.equal(counted, 100_000);
		assert.equal(last, 'notes/page-99999.md');
	}
	finally {
		workspace.close();
	}
});

/** An ink path as the file stores it: a count, then zigzag deltas per axis. */
function inkPath(deltas: readonly number[]): Uint8Array {
	const bytes: number[] = [];

	const varint = (value: number) => {
		let remaining = value;
		for (;;) {
			const seven = remaining % 128;
			remaining = Math.floor(remaining / 128);
			bytes.push(remaining > 0 ? seven | 0x80 : seven);
			if (remaining === 0) return;
		}
	};

	varint(deltas.length * 2);
	for (const delta of deltas) varint(delta < 0 ? -delta * 2 + 1 : delta * 2);

	return new Uint8Array(bytes);
}

test('a streamed ink path is the arrays it replaced, point for point', () => {
	const next = random(90210);

	for (const [points, dimensions] of [[1, 2], [2, 2], [7, 2], [500, 2], [1000, 3]]) {
		// Deltas laid out the way the format lays them out: every value of the
		// first axis, then every value of the second.
		const deltas = Array.from(
			{ length: points * dimensions },
			() => Math.floor(next() * 2000) - 1000);

		const bytes = inkPath(deltas);

		// The oracle: the array decoders, on the whole path at once.
		const encoded = decodeSignedVector(bytes, Infinity);
		assert.equal(encoded.length, points * dimensions, 'the constructed path did not round-trip');

		const expected: number[][] = [];
		const xs = decodePacketValues(encoded, 0 * points, points);
		const ys = decodePacketValues(encoded, 1 * points, points);
		for (let index = 0; index < points; index++) expected.push([xs[index], ys[index]]);

		// The streamed decoder, over a window too small to hold the path and a
		// spool whose chunks are far smaller than one axis.
		withStore(store => {
			const spool = new ByteSpool(store, 200, 0, 64);
			const window = new ByteWindow(new Uint8ArrayByteSource(bytes), 4096);
			const actual: number[][] = [];

			const drawn = decodeInkPath(
				new RangeReader(window, { offset: 0, length: bytes.length }),
				48, spool, dimensions, 0, 1, Infinity,
				(x, y) => actual.push([x, y]));

			assert.ok(drawn, `${points} points x ${dimensions} dimensions: nothing was drawn`);
			assert.deepEqual(actual, expected,
				`${points} points x ${dimensions} dimensions: streamed points differ from the arrays`);

			// The claim: the spool held one axis, and memory held two chunks of
			// it however long the axis was.
			assert.equal(spool.length, points * 8, 'the spool should hold exactly the first axis');
			assert.ok(spool.residentBytes <= 64,
				`${spool.residentBytes} bytes resident for a ${points}-point axis`);
		});
	}
});

test('a streamed ink path pairs the axes the file named, in either order', () => {
	// Two points, first axis deltas [10, 5], second [100, -20]: as x-then-y
	// that is (10,100),(15,80) and as y-then-x it is (100,10),(80,15).
	const bytes = inkPath([10, 5, 100, -20]);

	const cases: [number, number, number[][]][] = [
		[0, 1, [[10, 100], [15, 80]]],
		[1, 0, [[100, 10], [80, 15]]],
	];

	for (const [xIndex, yIndex, expected] of cases) {
		withStore(store => {
			const spool = new ByteSpool(store, 201, 0, 16);
			const window = new ByteWindow(new Uint8ArrayByteSource(bytes), 4096);
			const actual: number[][] = [];

			decodeInkPath(
				new RangeReader(window, { offset: 0, length: bytes.length }),
				8, spool, 2, xIndex, yIndex, Infinity,
				(x, y) => actual.push([x, y]));

			assert.deepEqual(actual, expected, `x at ${xIndex}, y at ${yIndex}`);
		});
	}
});

test('a streamed ink path refuses what the array decoder refused', () => {
	withStore(store => {
		const spool = new ByteSpool(store, 202, 0, 64);
		const read = (bytes: Uint8Array) => new RangeReader(
			new ByteWindow(new Uint8ArrayByteSource(bytes), 4096),
			{ offset: 0, length: bytes.length });

		const path = inkPath([1, 2, 3, 4]);

		// Over the value ceiling, which is what `--max-ink-path-values` sets.
		assert.throws(
			() => decodeInkPath(read(path), 8, spool, 2, 0, 1, 3, () => {}),
			/ONENOTE_INK_PATH_LIMIT|configured property value limit/);

		// Truncated: the count says four values and only two follow.
		assert.throws(
			() => decodeInkPath(read(path.subarray(0, 3)), 8, spool, 2, 0, 1, Infinity, () => {}),
			(error: { code: string }) => /ONENOTE_INK_PATH_TRUNCATED|ONENOTE_INK_VARINT/.test(error.code));

		// A count that does not divide into whole points draws nothing, and
		// says so by returning rather than by throwing — the same as before.
		assert.equal(decodeInkPath(read(inkPath([1, 2, 3])), 8, spool, 2, 0, 1, Infinity, () => {}), false);

		// Nothing at all.
		assert.equal(decodeInkPath(read(new Uint8Array(0)), 8, spool, 2, 0, 1, Infinity, () => {}), false);
	});
});

test('a page of dense ink converts with the arrays it would have allocated', async () => {
	// Eighty thousand points is 640 KiB of coordinates on each axis, well past
	// any budget this runs under, and the eager decoder would have held three
	// arrays of it at once.
	const points = 80_000;
	const next = random(1234);
	const deltas = Array.from({ length: points * 2 }, () => Math.floor(next() * 40) - 20);
	const bytes = inkPath(deltas);

	await withStoreAsync(async store => {
		const spool = new ByteSpool(store, 203, 0, 512);
		const window = new ByteWindow(new Uint8ArrayByteSource(bytes), 8192);
		const collector = new StrokeCollector(
			new ByteSpool(store, 204, 0, 512), new RecordSpool(store, 205, 0));

		const first = collector.beginStroke();
		const drawn = decodeInkPath(
			new RangeReader(window, { offset: 0, length: bytes.length }),
			256, spool, 2, 0, 1, Infinity,
			(x, y) => collector.pushPoint(x, y));

		assert.ok(drawn);
		collector.endStroke(first, '#000000', 1, 1);

		// The oracle, run once to check the streamed extent matches. This is
		// the allocation the conversion no longer makes; the test is allowed
		// to make it because the test is what it is being compared against.
		const encoded = decodeSignedVector(bytes, Infinity);
		const xs = decodePacketValues(encoded, 0, points);
		const ys = decodePacketValues(encoded, points, points);

		assert.equal(collector.minX, Math.min(...xs));
		assert.equal(collector.maxX, Math.max(...xs));
		assert.equal(collector.minY, Math.min(...ys));
		assert.equal(collector.maxY, Math.max(...ys));

		// And the whole reason for it: nothing scaled with the point count.
		assert.ok(spool.residentBytes <= 512, `${spool.residentBytes} bytes resident`);
		assert.equal(spool.length, points * 8, 'one axis, spooled');
	});
});

// -- The dimension table, a record at a time ---------------------------------

/** A dimension table: GUIDs with their bounds, as the format lays them out. */
function dimensionTable(ids: readonly string[]): Uint8Array {
	const table = new Uint8Array(ids.length * 32);

	ids.forEach((id, index) => {
		const hex = id.replace(/-/g, '');
		const raw = new Uint8Array(16);
		for (let byte = 0; byte < 16; byte++) {
			raw[byte] = Number.parseInt(hex.slice(byte * 2, byte * 2 + 2), 16);
		}

		// Mixed-endian, the spelling `readGuid` reverses.
		const at = index * 32;
		table.set([raw[3], raw[2], raw[1], raw[0], raw[5], raw[4], raw[7], raw[6]], at);
		table.set(raw.subarray(8, 16), at + 8);

		const bounds = new DataView(table.buffer, at + 16, 8);
		bounds.setUint32(0, 0, true);
		bounds.setUint32(4, 32767, true);
	});

	return table;
}

/** A reader over bytes, through a window, as the conversion sees them. */
function tableReader(bytes: Uint8Array): RangeReader {
	return new RangeReader(
		new ByteWindow(new Uint8ArrayByteSource(bytes), bytes.length + 64),
		{ offset: 0, length: bytes.length });
}

test('a streamed dimension table is the array it replaced', () => {
	const pressure = InkDimensionId.pressure;
	const tables: readonly string[][] = [
		[InkDimensionId.x, InkDimensionId.y],
		[InkDimensionId.y, InkDimensionId.x],
		[pressure, InkDimensionId.x, InkDimensionId.y],
		[InkDimensionId.x, pressure, InkDimensionId.y, pressure],
		// An axis named twice: `findIndex` answers with the first.
		[InkDimensionId.x, InkDimensionId.x, InkDimensionId.y],
		// No y at all, which is how a stroke gets skipped.
		[InkDimensionId.x, pressure],
		[],
	];

	for (const ids of tables) {
		const bytes = dimensionTable(ids);

		// The eager path, kept as the oracle.
		const eager = decodeDimensions(bytes.length > 0 ? bytes : undefined);
		const expected = {
			count: eager.length,
			xIndex: indexOfDimension(eager, InkDimensionId.x),
			yIndex: indexOfDimension(eager, InkDimensionId.y),
		};

		const streamed = readInkDimensions(
			bytes.length > 0 ? tableReader(bytes) : undefined,
			InkDimensionId.x, InkDimensionId.y);

		assert.deepEqual(streamed, expected, `[${ids.join(', ')}]`);
	}
});

test('a streamed dimension table ignores a trailing part-record, as the array did', () => {
	// Seventeen bytes past the last whole record: the eager loop advances only
	// while thirty-two remain, so the fragment is not a dimension and not an
	// error either.
	const whole = dimensionTable([InkDimensionId.x, InkDimensionId.y]);
	const ragged = new Uint8Array(whole.length + 17);
	ragged.set(whole);

	const eager = decodeDimensions(ragged);
	const streamed = readInkDimensions(tableReader(ragged), InkDimensionId.x, InkDimensionId.y);

	assert.equal(streamed.count, eager.length);
	assert.equal(streamed.count, 2);
	assert.deepEqual(
		[streamed.xIndex, streamed.yIndex],
		[indexOfDimension(eager, InkDimensionId.x), indexOfDimension(eager, InkDimensionId.y)]);
});

test('a dimension table a file can only claim costs nothing to walk', () => {
	// The table that made the old ceiling necessary: two million records, so
	// the eager array would be two million objects and sixty-four megabytes of
	// bytes before it. Walked here through a window a fraction of its size,
	// which is the point — no ceiling is needed to make this safe.
	const records = 2_000_000;
	const ids = [InkDimensionId.x, InkDimensionId.y];
	const bytes = new Uint8Array(records * 32);

	// Only the first two records need real identifiers; the rest are zeroes,
	// which is a dimension the conversion does not recognise and does not
	// allocate for either.
	bytes.set(dimensionTable(ids));

	const capacity = 64 * 1024;
	const window = new ByteWindow(new Uint8ArrayByteSource(bytes), capacity);

	const streamed = readInkDimensions(
		new RangeReader(window, { offset: 0, length: bytes.length }),
		InkDimensionId.x, InkDimensionId.y);

	assert.deepEqual(streamed, { count: records, xIndex: 0, yIndex: 1 });
	assert.ok(window.residentBytes <= capacity,
		`the window held ${window.residentBytes} bytes of a ${bytes.length} byte table`);

	// And it stopped as soon as both axes were found, rather than walking two
	// million records to answer a question the first two records answered.
	assert.equal(window.refills, 1,
		'the walk should have read one window of a table it did not need the rest of');
});

// -- Values built out of many values -----------------------------------------

test('a value built from many parts is refused before it is built', () => {
	const limit = 1000;
	const meter = new ValueMeter();

	// Every part is well under the ceiling, which is exactly the case the old
	// per-part check passed and the aggregate failed.
	const part = 'x'.repeat(100);
	let value = '';

	for (let index = 0; index < 9; index++) {
		value = joinBounded(value, part, limit, 'A page title', meter);
	}

	assert.equal(value.length, 908, 'nine hundred-character parts and eight separators');

	assert.throws(
		() => joinBounded(value, part, limit, 'A page title', meter),
		(error: { code: string, message: string }) => {
			assert.equal(error.code, 'ONENOTE_VALUE_LIMIT');
			// The size it would have been, so the message names the real
			// overrun rather than the part that happened to tip it over.
			assert.match(error.message, /1009 characters, over the 1000-character limit/);
			return true;
		});

	// The peak the meter saw is the peak the reserve has to hold. A check made
	// after the join would have let it reach the limit plus a whole part.
	assert.ok(meter.peakValueChars <= limit,
		`the meter saw ${meter.peakValueChars} characters against a ${limit} limit`);
});

test('a single part over the ceiling is refused on its own', () => {
	// The degenerate aggregate: nothing yet, and one part too big for it.
	assert.throws(
		() => joinBounded('', 'y'.repeat(101), 100, 'A drawing\'s recognized text'),
		(error: { code: string, message: string }) => {
			assert.equal(error.code, 'ONENOTE_VALUE_LIMIT');
			assert.match(error.message, /recognized text is 101 characters/);
			return true;
		});
});

test('a value built from many parts is the string the join would have made', () => {
	// The rule may not change what a value under the ceiling looks like.
	const parts = ['Meeting', 'notes', 'for', 'Tuesday'];
	let value = '';
	for (const part of parts) value = joinBounded(value, part, 1000, 'A page title');

	assert.equal(value, parts.join(' '));
});

test('both values built out of many values go through the one rule', () => {
	// Structural, because the alternative is a synthetic section with four
	// hundred ink strokes and recognition properties on each — a page no
	// helper here can build, for a rule that is already exercised above.
	// What is worth pinning is that neither site grew its own arithmetic back.
	const page = nodeFs.readFileSync(
		nodePath.join(SOURCE_ROOT, 'src/stream/page.ts'), 'utf8');

	// A page title, from its runs.
	assert.match(page, /joinBounded\(this\.value, part, this\.limit, 'A page title'/);

	// A drawing's recognized text, from its strokes.
	assert.match(page, /words = joinBounded\(\s*words, recognized/);

	// And neither builds the string first and asks afterwards. Both aggregates
	// are assigned from `joinBounded` and nowhere else.
	const appends = [...page.matchAll(/^\s*(?:this\.value|words) \+?= (?!joinBounded)/gm)];
	assert.deepEqual(appends.map(match => match[0].trim()), [],
		'an aggregate is being built without the ceiling being checked first');
});
