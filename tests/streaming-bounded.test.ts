/**
 * The state the bounded path is not allowed to keep.
 *
 * `streaming.test.ts` checks that the conversion produces the right bytes and
 * `streaming-stress.test.ts` checks that the spools survive being large. This
 * checks the third thing: that the pieces which used to grow with the input no
 * longer do, and that the replacements behave exactly as what they replaced.
 *
 * Each of these was a real allocation before: a set holding every page a walk
 * had seen, a set holding every folder a sink had made, an array holding a path
 * per level of subpage nesting, an array of dashes per table column, a string
 * holding a whole table cell. The tests are written as equivalences against the
 * code that grew, because that is the property that matters — the smaller
 * version has to be indistinguishable from the larger one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { FsSink, MemorySink } from '../src/sinks';
import { OneNoteFormatError } from '../src/onenote-file/errors';
import { CellText, writeSeparatorRow } from '../src/stream/page';
import { ReportGroup, StreamWorkspace } from '../src/stream/workspace';
import { BufferedTextOut, writeJsonReport } from '../src/stream/report-json';
import {
	fixedBufferBytes,
	MINIMUM_BUDGET_BYTES,
	planBudget,
	reserveNeededFor,
	sectionStorageFor,
	workspaceStorageFor,
} from '../src/stream/budget';
import { ResidentAccount } from '../src/stream/account';
import { ValueMeter } from '../src/stream/limits';
import { StreamSection } from '../src/stream/section';
import { AssetWriter } from '../src/stream/assets';
import { asChunkedSink } from '../src/stream/sink';
import { convertFileStream } from '../src/stream/convert';
import { limitsFor, DEFAULT_STREAM_LIMITS } from '../src/stream/limits';
import { Uint8ArrayByteSource } from '../src/storage/byte-source';
import { NullSink } from '../src/sinks';
import { fixtures } from './helpers';

// -- Table cells -------------------------------------------------------------

/** What `renderCell` and its caller in `convert.ts` did, on whole strings. */
function cellTheOldWay(parts: string[]): string {
	return parts
		.filter(part => part !== '')
		.join(' ')
		.replace(/\s+/g, ' ')
		.replace(/\|/g, '\\|')
		.trim();
}

async function cellTheNewWay(parts: string[], chunk = 7): Promise<string> {
	let out = '';
	const cell = new CellText(async text => { out += text; });

	for (const part of parts) {
		cell.beginPart();
		for (let at = 0; at < part.length; at += chunk) await cell.push(part.slice(at, at + chunk));
		cell.endPart();
	}

	return out;
}

test('a streamed cell is the string the cell renderer built', async () => {
	const cases: string[][] = [
		[],
		[''],
		['', '', ''],
		['plain'],
		['  leading', 'trailing  '],
		['   '],
		['   ', 'after'],
		['before', '   '],
		['a', '', 'b'],
		['one | two', 'three|four'],
		['|'],
		['||||'],
		['\t\ttabs\t\t', '\r\ncarriage\r\n'],
		['line\nbreak', 'and\n\n\nmore'],
		// `\s` and `trim` both take more than ASCII whitespace.
		['\u00a0nbsp\u00a0', '\ufeffbom'],
		['\u2003em space'],
		['emoji \u{1f600} pair'],
		['ends with pipe|', '|starts with pipe'],
		['   |   ', '   |   '],
		['mixed \t \n | \u00a0 stuff'],
	];

	for (const parts of cases) {
		for (const chunk of [1, 2, 3, 7, 1000]) {
			assert.equal(
				await cellTheNewWay(parts, chunk),
				cellTheOldWay(parts),
				`parts ${JSON.stringify(parts)} at chunk size ${chunk}`);
		}
	}
});

test('a streamed cell agrees with the string one on random input', async () => {
	// A small alphabet, weighted towards the characters the transform cares
	// about, so collisions of whitespace, pipes and content are common.
	const alphabet = [...'ab|  \t\n\r\u00a0|\u2003x'];
	let seed = 20260908;
	const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0x1_0000_0000;

	for (let round = 0; round < 400; round++) {
		const parts: string[] = [];
		for (let part = 0, count = Math.floor(next() * 5); part < count; part++) {
			let text = '';
			for (let index = 0, length = Math.floor(next() * 12); index < length; index++) {
				text += alphabet[Math.floor(next() * alphabet.length)];
			}
			parts.push(text);
		}

		assert.equal(
			await cellTheNewWay(parts, 1 + Math.floor(next() * 4)),
			cellTheOldWay(parts),
			`round ${round}: ${JSON.stringify(parts)}`);
	}
});

test('a cell holding two million characters is normalized without being held', async () => {
	// Deliberately awful: alternating whitespace and pipes, so every character
	// exercises the collapse or the escape, and the result is far shorter than
	// the input.
	const unit = ' \t|\n';
	const repeats = 500_000;

	let length = 0;
	let pipes = 0;
	const cell = new CellText(async text => {
		length += text.length;
		for (const character of text) if (character === '|') pipes++;
	});

	cell.beginPart();
	for (let index = 0; index < repeats; index++) await cell.push(unit);
	cell.endPart();

	// ' \t|\n' repeated collapses to '| ' per repeat, escaped to '\\| ', and
	// the leading and trailing whitespace go. Whatever the exact count, what
	// matters is that a two-million-character cell produced a bounded number
	// of pipes and that nothing accumulated on the way.
	assert.equal(pipes, repeats);
	assert.equal(length, repeats * 3 - 1);
});

// -- Table separators --------------------------------------------------------

test('a written separator row is the array-built one', async () => {
	for (const columns of [0, 1, 2, 3, 17, 512]) {
		let out = '';
		await writeSeparatorRow(columns, async text => { out += text; });

		assert.equal(out, `\n| ${new Array(columns).fill('---').join(' | ')} |`, `${columns} columns`);
	}
});

test('a separator row for a hundred thousand columns is written in pieces', async () => {
	const columns = 100_000;

	let length = 0;
	let widest = 0;
	await writeSeparatorRow(columns, async text => {
		length += text.length;
		widest = Math.max(widest, text.length);
	});

	assert.equal(length, `\n| ${new Array(columns).fill('---').join(' | ')} |`.length);
	assert.ok(widest <= 6, `a piece was ${widest} characters, so the row was built rather than written`);
});

// -- Sinks -------------------------------------------------------------------

test('a sink writing into thousands of folders keeps none of them', () => {
	const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-dirs-'));

	try {
		const sink = new FsSink(root, true);
		const folders = 2000;

		for (let index = 0; index < folders; index++) {
			sink.write(`notebook/section ${index}/note.md`, new TextEncoder().encode(`${index}`));
		}

		// Going back to folders already written to is the case the cache used
		// to cover, and the case a `mkdir` that is not idempotent would break.
		for (let index = 0; index < folders; index += 7) {
			sink.write(`notebook/section ${index}/again.md`, new TextEncoder().encode('again'));
		}

		for (let index = 0; index < folders; index++) {
			assert.equal(
				nodeFs.readFileSync(nodePath.join(root, 'notebook', `section ${index}`, 'note.md'), 'utf8'),
				`${index}`);
		}
		for (let index = 0; index < folders; index += 7) {
			assert.equal(
				nodeFs.readFileSync(nodePath.join(root, 'notebook', `section ${index}`, 'again.md'), 'utf8'),
				'again');
		}

		// What the sink remembers is where it wrote last, and which files are
		// open right now — of which, having finished, there are none. Anything
		// it holds may be a collection; what it may not be is a collection
		// that grew with the thousands of folders just written.
		assert.equal(sink.openCount, 0, 'every writer should have deregistered on close');

		const own = Object.values(sink as unknown as Record<string, unknown>);
		for (const value of own) {
			const held = value instanceof Set || value instanceof Map
				? value.size
				: Array.isArray(value) ? value.length : 0;

			assert.ok(held <= 2,
				`the sink is holding ${held} entries after ${folders} folders, `
				+ 'which is a collection that grows with the output');
		}
	}
	finally {
		nodeFs.rmSync(root, { recursive: true, force: true });
	}
});

// -- Subpage nesting ---------------------------------------------------------

test('the stored subpage levels behave as the array they replaced', () => {
	const workspace = new StreamWorkspace();

	try {
		let seed = 7;
		const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 0x1_0000_0000;

		const array: string[] = ['root'];
		const stored = workspace.openSubpageLevels('root');

		for (let page = 0; page < 5000; page++) {
			const level = Math.floor(next() * 4);

			const arrayDepth = Math.min(level, array.length - 1);
			array.length = arrayDepth + 1;
			const arrayTarget = array[arrayDepth];

			const storedDepth = Math.min(level, stored.depth);
			stored.truncate(storedDepth);
			const storedTarget = stored.at(storedDepth);

			assert.equal(storedDepth, arrayDepth, `depth differs at page ${page}`);
			assert.equal(storedTarget, arrayTarget, `folder differs at page ${page}`);

			array.push(`${arrayTarget}/page ${page}`);
			stored.set(storedDepth + 1, `${storedTarget}/page ${page}`);
		}
	}
	finally {
		workspace.close();
	}
});

test('subpages nesting all the way down cost the store, not the heap', () => {
	const workspace = new StreamWorkspace();

	try {
		const levels = workspace.openSubpageLevels('root');
		const deepest = 2000;

		// Every page one level deeper than the last, which is the shape that
		// made the array as long as the section. The paths themselves still
		// grow with the nesting — a folder inside a folder has a longer name,
		// on any path and in any filesystem — but only one of them is held.
		for (let page = 0; page < deepest; page++) {
			const depth = Math.min(page, levels.depth);
			levels.truncate(depth);
			levels.set(depth + 1, `${levels.at(depth)}/p${page}`);
		}

		assert.equal(levels.depth, deepest);
		assert.ok(levels.at(deepest).startsWith('root/p0/p1/p2/'));
		assert.equal(levels.at(deepest).split('/').length, deepest + 1);
	}
	finally {
		workspace.close();
	}
});

// -- Visited pages -----------------------------------------------------------

test('a section can be walked twice, and each walk skips its own repeats', () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'testOneNote.one')!;
	const data = new Uint8Array(nodeFs.readFileSync(fixture.path));

	const workspace = new StreamWorkspace();
	const assets = new AssetWriter(asChunkedSink(new NullSink()), workspace, { writeAttachments: false });
	const section = StreamSection.open(new Uint8ArrayByteSource(data), assets);

	try {
		const first = [...section.pages()].map(page => page.id);
		const second = [...section.pages()].map(page => page.id);

		assert.ok(first.length > 0, 'the fixture produced no pages');
		assert.deepEqual(second, first, 'the second walk saw a different set of pages');
		assert.equal(new Set(first).size, first.length, 'a page was yielded twice in one walk');
	}
	finally {
		section.close();
		workspace.close();
	}
});

test('the metadata pre-count is exact and leaves the conversion walk intact', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'handwriting_recognition.one')!;
	const data = new Uint8Array(nodeFs.readFileSync(fixture.path));

	const workspace = new StreamWorkspace();
	const assets = new AssetWriter(asChunkedSink(new NullSink()), workspace, { writeAttachments: false });
	const section = StreamSection.open(new Uint8ArrayByteSource(data), assets);

	try {
		const expected = [...section.pages()].filter(page => !page.isDeleted).length;
		assert.ok(expected > 1, 'the fixture should prove a changing progress index');
		assert.equal(await section.countPages(false), expected);
		assert.equal([...section.pages()].length, expected,
			'counting consumed or changed the following page traversal');

		// No committed fixture currently contains a deleted page, but this
		// still pins includeDeleted to the same filter the conversion walk uses.
		const all = [...section.pages()];
		assert.equal(await section.countPages(true), all.length);
		assert.equal(await section.countPages(false), all.filter(page => !page.isDeleted).length);
	}
	finally {
		section.close();
		workspace.close();
	}
});

test('bounded note progress carries the exact filtered total', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'handwriting_recognition.one')!;
	const data = new Uint8Array(nodeFs.readFileSync(fixture.path));
	const events: { index: number, total: number }[] = [];
	const workspace = new StreamWorkspace();

	try {
		await convertFileStream(data, fixture.name, new NullSink(), {
			workspace,
			onProgress: event => {
				if (event.kind === 'note') events.push({ index: event.index, total: event.total });
			},
		});

		assert.deepEqual(events, [
			{ index: 1, total: 2 },
			{ index: 2, total: 2 },
		]);
	}
	finally {
		workspace.close();
	}
});

test('the page pre-count keeps no per-page heap collection', () => {
	const source = nodeFs.readFileSync(nodePath.join(SOURCE_ROOT, 'src/stream/section.ts'), 'utf8');
	const count = source.slice(source.indexOf('async countPages('), source.indexOf('\n\t/**', source.indexOf('async countPages(')));

	assert.doesNotMatch(count, /new (?:Set|Map)|\[\]|\.push\(/,
		'the pre-count should count scalars while visited IDs stay in the paged store');
	assert.match(count, /#pageSpaceIds\(\)/);
});

// -- The report, streamed ----------------------------------------------------

test('the streamed JSON report is what JSON.stringify would have produced', () => {
	const workspace = new StreamWorkspace();

	try {
		const groups: ReportGroup[] = [];

		// A mix worth checking: an input with everything, an input with
		// nothing, a name and items needing escaping, a failure with a code and
		// one without — since `JSON.stringify` omits an absent `code` and the
		// streamed version has to omit it the same way.
		for (const [input, notes, attachments, skips, errors] of [
			['a.one', 3, 2, 1, 1],
			['empty.one', 0, 0, 0, 0],
			['awkward "name"\\.one', 1, 0, 2, 2],
		] as [string, number, number, number, number][]) {
			const from = workspace.marks;

			for (let index = 0; index < notes; index++) workspace.recordNote(`${input}/note\t"${index}".md`);
			for (let index = 0; index < attachments; index++) workspace.recordAttachment(`${input}/a${index}.png`);
			for (let index = 0; index < skips; index++) workspace.recordSkipped(`page ${index}`, `item\n${index}`, 'no-data');
			for (let index = 0; index < errors; index++) {
				workspace.recordFailure(`thing ${index}`, index === 0
					? new OneNoteFormatError('ONENOTE_VALUE_LIMIT', 'a value was too large')
					: new Error('no code at all'));
			}

			groups.push({ input, from, to: workspace.marks, cancelled: false });
		}

		const meta = { ok: false, out: 'out dir', dryRun: true };

		// The eager path's exact expression, over arrays built for the purpose.
		const reports = groups.map(group => ({
			input: group.input,
			notes: [...workspace.notes(group.from.notes, group.to.notes)],
			attachments: [...workspace.attachments(group.from.attachments, group.to.attachments)],
			skipped: [...workspace.skips(group.from.skipped, group.to.skipped)],
			errors: [...workspace.failures(group.from.errors, group.to.errors)],
			cancelled: group.cancelled,
		}));
		const expected = `${JSON.stringify({ ...meta, reports }, null, 2)}\n`;

		let actual = '';
		const out = new BufferedTextOut(text => { actual += text; }, 64);
		writeJsonReport(out, workspace, groups, meta);
		out.flush();

		assert.equal(actual, expected);
	}
	finally {
		workspace.close();
	}
});

test('an empty report is still the document the eager path writes', () => {
	const workspace = new StreamWorkspace();

	try {
		let actual = '';
		const out = new BufferedTextOut(text => { actual += text; });
		writeJsonReport(out, workspace, [], { ok: true, out: 'out', dryRun: false });
		out.flush();

		assert.equal(actual,
			`${JSON.stringify({ ok: true, out: 'out', dryRun: false, reports: [] }, null, 2)}\n`);
	}
	finally {
		workspace.close();
	}
});

test('a report of many notes is written in pieces, never as one string', () => {
	const workspace = new StreamWorkspace();

	try {
		const from = workspace.marks;
		for (let index = 0; index < 50_000; index++) workspace.recordNote(`section/note ${index}.md`);
		const groups: ReportGroup[] = [{ input: 'big.one', from, to: workspace.marks, cancelled: false }];

		let pieces = 0;
		let widest = 0;
		let total = 0;

		const out = new BufferedTextOut(text => {
			pieces++;
			widest = Math.max(widest, text.length);
			total += text.length;
		}, 8192);
		writeJsonReport(out, workspace, groups, { ok: true, out: 'out', dryRun: false });
		out.flush();

		assert.ok(total > 1_000_000, `a fifty-thousand-note report was only ${total} characters`);
		assert.ok(pieces > 100, `it came out in ${pieces} pieces, so it was assembled first`);
		// The buffer flushes once it reaches capacity, so the widest piece is
		// the capacity plus the one write that crossed it.
		assert.ok(widest < 8192 * 2, `a piece was ${widest} characters, over the buffer`);
	}
	finally {
		workspace.close();
	}
});

// -- Whole-run accounting ----------------------------------------------------

test('every store and the window together stay inside the planned budget', () => {
	const budget = planBudget(1024 * 1024);

	assert.ok(budget.accountedBytes <= budget.totalBytes);

	for (const name of ['testOneNote.one', 'testOneNoteFromOffice365.one', 'handwriting_recognition.one']) {
		const entry = fixtures(['.one']).find(candidate => candidate.name === name);
		if (!entry) continue;

		const data = new Uint8Array(nodeFs.readFileSync(entry.path));
		const workspace = new StreamWorkspace(undefined, workspaceStorageFor(budget));
		const sink = asChunkedSink(new NullSink());
		const assets = new AssetWriter(sink, workspace, { writeAttachments: true });

		const section = StreamSection.open(
			new Uint8ArrayByteSource(data), assets, sectionStorageFor(budget));

		let peak = 0;
		try {
			for (const page of section.pages()) {
				const writer = sink.open(`${page.title}.md`);
				peak = Math.max(peak, resident(section, workspace));
				void writer;
			}
			peak = Math.max(peak, resident(section, workspace));
		}
		finally {
			section.close();
			workspace.close();
		}

		// The caches and the window are what the budget names; the claim is
		// that all three stores and the window together honour it.
		assert.ok(peak <= budget.totalBytes,
			`${name} held ${peak} bytes resident against a ${budget.totalBytes}-byte budget`);
	}
});

function resident(section: StreamSection, workspace: StreamWorkspace): number {
	return section.stats.residentBytes + workspace.store.cacheStats.residentBytes;
}

// -- Value ceilings ----------------------------------------------------------

test('the value ceilings are exactly what their reserve pays for', () => {
	for (const reserve of [96 * 1024, 128 * 1024, 1024 * 1024, 64 * 1024 * 1024]) {
		const limits = limitsFor(reserve);

		// The contract: a conversion that stays inside its ceilings cannot put
		// the budget over, because the ceilings were inverted from the reserve.
		assert.ok(reserveNeededFor(limits) <= reserve,
			`${reserve}: ceilings need ${reserveNeededFor(limits)} bytes, more than was reserved`);
		// And not so far under that the reserve is mostly unusable.
		assert.ok(reserveNeededFor(limits) >= reserve * 0.99,
			`${reserve}: ceilings only claim ${reserveNeededFor(limits)} of it`);

		assert.ok(limits.maxValueChars > limits.maxMathChars,
			'values are the common case and should get the larger share');
	}

	assert.equal(limitsFor(1024 * 1024, { maxValueChars: 10 }).maxValueChars, 10,
		'an explicit override still wins');
	assert.equal(limitsFor(1024 * 1024).maxTableColumns, DEFAULT_STREAM_LIMITS.maxTableColumns);
});

test('a planned budget accounts for the values it will let through', () => {
	for (const total of [1024 * 1024, 8 * 1024 * 1024, 512 * 1024 * 1024]) {
		const budget = planBudget(total);

		assert.ok(reserveNeededFor(budget.limits) <= budget.valueReserveBytes,
			`${total}: the limits admit values the reserve has not paid for`);
		assert.ok(budget.accountedBytes <= total,
			`${total}: the reserve pushed the accounting over the budget`);

		// Generous against reality: the largest value any committed fixture
		// materializes is forty-four characters.
		assert.ok(budget.limits.maxValueChars >= 4096,
			`${total}: a ${budget.limits.maxValueChars}-character ceiling is too tight for real notes`);
		assert.ok(budget.limits.maxMathChars >= 1024,
			`${total}: a ${budget.limits.maxMathChars}-character maths ceiling is too tight`);
	}
});

test('no committed fixture comes close to the smallest budget ceilings', async () => {
	// The reserve floor was chosen from this measurement, so it is worth
	// keeping honest: if a fixture ever needs a large value, the floor is
	// wrong and this says so before a user finds out.
	const budget = planBudget(MINIMUM_BUDGET_BYTES);
	let worstValue = 0;
	let worstMath = 0;

	for (const entry of fixtures(['.one'])) {
		const meter = new ValueMeter();
		const sink = new MemorySink();
		const workspace = new StreamWorkspace();

		try {
			await convertFileStream(new Uint8Array(nodeFs.readFileSync(entry.path)), entry.name, sink, {
				workspace,
				storage: { ...sectionStorageFor(budget), limits: { ...budget.limits, meter } },
			});

			assert.deepEqual([...workspace.failures()], [],
				`${entry.name} failed under the minimum budget`);
		}
		finally {
			workspace.close();
		}

		worstValue = Math.max(worstValue, meter.peakValueChars);
		worstMath = Math.max(worstMath, meter.peakMathChars);
	}

	assert.ok(worstValue > 0, 'no fixture materialized a value, so nothing was measured');
	assert.ok(worstValue * 8 < budget.limits.maxValueChars,
		`the largest value is ${worstValue} characters against a ${budget.limits.maxValueChars} `
		+ 'ceiling, which leaves less than eight times the headroom the floor was chosen for');
	assert.ok(worstMath * 8 < budget.limits.maxMathChars,
		`the largest maths run is ${worstMath} characters against ${budget.limits.maxMathChars}`);
});

test('the account adds up what the budget covers, and nothing per page', async () => {
	const budget = planBudget(1024 * 1024);
	const account = new ResidentAccount();
	// Counted, not kept: a `MemorySink` here would hold every note and every
	// attachment, which is the test measuring its own sink alongside the
	// converter it is trying to measure.
	const sink = new NullSink();
	const workspace = new StreamWorkspace(undefined, workspaceStorageFor(budget));

	account.declare(fixedBufferBytes(budget), budget.valueReserveBytes, budget.totalBytes);
	account.setMeter(new ValueMeter());
	account.addCache(workspace, () => workspace.store.cacheStats.highWaterBytes);

	try {
		const entry = fixtures(['.one']).find(candidate => candidate.name === 'handwriting_recognition.one')!;

		await convertFileStream(new Uint8Array(nodeFs.readFileSync(entry.path)), entry.name, sink, {
			workspace,
			storage: { ...sectionStorageFor(budget), account },
		});

		const reading = account.read();

		// Three caches — the workspace store, the index, the conversion store —
		// registered once each however many pages went through.
		assert.equal(reading.caches, 1,
			'a section releases its caches when it closes, leaving the workspace');
		assert.equal(reading.fixedBytes, fixedBufferBytes(budget));
		assert.equal(reading.valueReserveBytes, budget.valueReserveBytes);
		assert.ok(reading.valueObservedBytes < reading.valueReserveBytes,
			'a real file used the whole reserve, so the floor is wrong');

		assert.ok(account.peakHighWaterBytes <= budget.totalBytes,
			`the run held ${account.peakHighWaterBytes} against a ${budget.totalBytes}-byte budget`);
		assert.ok(account.peakHighWaterBytes > reading.highWaterBytes
			|| reading.highWaterBytes === account.peakHighWaterBytes,
			'the peak should never be under a reading');

		// Every page was rendered, not just walked: a high water taken over a
		// run that skipped the content would be measuring nothing.
		assert.ok(sink.files > 0 && sink.bytes > 0,
			'the conversion should have produced output to have measured anything');

		// And the copies handed out of the stores fit what the budget reserves
		// for them, which is the part that used to go unaccounted.
		assert.ok(reading.recordCopyBytes <= budget.recordCopyBytes,
			`record copies reached ${reading.recordCopyBytes} against a `
			+ `${budget.recordCopyBytes} reserve`);
	}
	finally {
		workspace.close();
	}
});

test('a value past its ceiling fails that page and names the option', async () => {
	const data = new Uint8Array(
		nodeFs.readFileSync(fixtures(['.one']).find(entry => entry.name === 'testOneNote.one')!.path));

	const sink = new MemorySink();
	const workspace = new StreamWorkspace();

	try {
		// Four characters is smaller than any real title, style identifier or
		// link, so the ceiling is certain to be met.
		await convertFileStream(data, 'testOneNote.one', sink, {
			workspace,
			storage: { limits: { maxValueChars: 4 } },
		});

		const failures = [...workspace.failures()];
		assert.ok(failures.length > 0, 'nothing failed under a four-character ceiling');
		assert.ok(failures.some(failure => failure.code === 'ONENOTE_VALUE_LIMIT'),
			`no failure carried the limit code: ${JSON.stringify(failures.map(f => f.code))}`);
		assert.ok(failures.some(failure => failure.message.includes('maxValueChars')),
			'the failure did not say which option to raise');
	}
	finally {
		workspace.close();
	}
});

test('a table wider than the column limit fails that page and names the option', async () => {
	const data = new Uint8Array(nodeFs.readFileSync(
		fixtures(['.one']).find(entry => entry.name === 'handwriting_recognition.one')!.path));

	const sink = new MemorySink();
	const workspace = new StreamWorkspace();

	try {
		await convertFileStream(data, 'handwriting_recognition.one', sink, {
			workspace,
			storage: { limits: { maxTableColumns: 0 } },
		});

		const failures = [...workspace.failures()];
		assert.ok(failures.some(failure => failure.code === 'ONENOTE_STRUCTURE_LIMIT'),
			`no failure carried the structure limit code: ${JSON.stringify(failures.map(f => f.code))}`);
		assert.ok(failures.some(failure => failure.message.includes('maxTableColumns')),
			'the failure did not say which option to raise');
	}
	finally {
		workspace.close();
	}
});

test('a cancellation part way through a note leaves no note behind', async () => {
	const entry = fixtures(['.one']).find(candidate => candidate.name === 'testOneNote.one')!;
	const data = new Uint8Array(nodeFs.readFileSync(entry.path));

	// Cancel once the first note has started but before it can finish: the
	// renderer checks between a page's top-level children, so a page with more
	// than one of them is interrupted mid-file.
	let elements = 0;
	const sink = new MemorySink();
	const workspace = new StreamWorkspace();

	try {
		await convertFileStream(data, entry.name, sink, {
			workspace,
			isCancelled: () => ++elements > 2,
		});

		assert.ok(workspace.cancelled, 'the workspace should say it was cancelled');
		assert.deepEqual([...workspace.notes()], [],
			'a note interrupted half way through must not be recorded');
		assert.deepEqual([...workspace.failures()], [],
			'a cancellation is not a failure of the page it interrupted');

		// And nothing half-written is left in the sink. `MemorySink` keeps
		// whatever `write` was called with, so an aborted writer showing up
		// here would be a partial file on disk under `FsSink`.
		assert.deepEqual([...sink.files.keys()].filter(name => name.endsWith('.md')), [],
			'the aborted note should have been removed, not written');
	}
	finally {
		workspace.close();
	}
});

test('a cancellation between pages keeps the notes already finished', async () => {
	const entry = fixtures(['.one']).find(candidate => candidate.name === 'handwriting_recognition.one')!;
	const data = new Uint8Array(nodeFs.readFileSync(entry.path));

	// A generous allowance, so the first page completes and a later one does
	// not. The fixture has two pages.
	let checks = 0;
	const sink = new MemorySink();
	const workspace = new StreamWorkspace();

	try {
		await convertFileStream(data, entry.name, sink, {
			workspace,
			isCancelled: () => ++checks > 40,
		});

		assert.ok(workspace.cancelled);

		const notes = [...workspace.notes()];
		const written = [...sink.files.keys()].filter(name => name.endsWith('.md'));

		// Whatever was recorded was also written, and nothing was written that
		// was not recorded. That equality is the invariant a partial note
		// broke: it was written and recorded, but incomplete.
		assert.deepEqual(
			[...notes].sort(),
			written.sort(),
			'the recorded notes and the written files should be the same set');
	}
	finally {
		workspace.close();
	}
});

/** Text spills in one `SpillSet`, which `budget.ts` keeps its own count of. */
const SPILL_REGIONS_FOR_TEST = 4;

const SOURCE_ROOT = nodePath.resolve(
	nodePath.dirname(fileURLToPath(import.meta.url)), '..');

test('the budget counts every chunk buffer a section actually allocates', () => {
	// The count in `budget.ts` was wrong twice: once when a spool was added to
	// `SpillSet` and the constant was not, and once for the ink cursor's
	// buffer, which is the same size and is not a spool. Both were arithmetic
	// that no test could see, so this counts the allocations at the source
	// instead of restating the number.
	const spills = nodeFs.readFileSync(nodePath.join(SOURCE_ROOT, 'src/stream/spills.ts'), 'utf8');
	const spools = [...spills.matchAll(/new ByteSpool\(/g)].length;

	const ink = nodeFs.readFileSync(nodePath.join(SOURCE_ROOT, 'src/stream/ink.ts'), 'utf8');
	const cursors = [...ink.matchAll(/new Uint8Array\(\s*Math\.max\(1, Math\.min\(stepBytes/g)].length;

	const budget = planBudget(8 * 1024 * 1024);
	const buffers = (spools + cursors) * budget.chunkBytes;

	// `fixedBufferBytes` is what the account compares against the budget, so
	// checking the chunk part of it against the count is checking the thing
	// the claim rests on.
	const rest = SPILL_REGIONS_FOR_TEST * budget.spillChars * 2
		+ budget.noteBufferBytes + budget.recordCopyBytes;

	assert.equal(fixedBufferBytes(budget) - rest, buffers,
		`${spools} spools and ${cursors} cursor buffers are allocated, but the budget `
		+ `accounts for ${(fixedBufferBytes(budget) - rest) / budget.chunkBytes}`);
});
