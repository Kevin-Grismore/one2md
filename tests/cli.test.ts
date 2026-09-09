/**
 * The command line, run as a command line.
 *
 * The bounded path is reached through two flags, and flags are the part of a
 * program most easily broken by a refactor that never touches them: a renamed
 * option, an exit code that changed, a message that stopped naming the thing to
 * do about it. So these spawn the CLI rather than calling into it, and assert on
 * what a user actually sees — stdout, stderr, the exit code, and the files that
 * appeared on disk.
 *
 * The through-line is that `--memory-budget` must change how the conversion is
 * done and nothing about what it produces. Every conversion here is run twice,
 * once each way, and compared.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { FsSink } from '../src/sinks';
import { PagedKeyValueStore } from '../src/storage/paged-key-value-store';
import { describe, MINIMUM_BUDGET_BYTES, planBudget, BudgetError } from '../src/stream/budget';
import { Closers } from '../src/stream/run';
import { FIXTURES, readTree } from './helpers';

const ROOT = nodePath.resolve(FIXTURES, '..', '..');
const TSX = nodePath.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = nodePath.join(ROOT, 'src', 'cli.ts');
/**
 * The built bundle, for the one test that needs a process it can signal.
 *
 * \ compiles in a child of its own, so a signal sent to it reaches the
 * wrapper and not the converter. Anything asserting on signal handling has to
 * go through the artifact that has no wrapper.
 */
const BUNDLE = nodePath.join(ROOT, 'dist', 'one2md.mjs');

/** A desktop-encoded loose section, and a web-encoded one. */
const DESKTOP = 'testOneNote.one';
const WEB = 'testOneNoteFromOffice365.one';

interface Run {
	status: number;
	stdout: string;
	stderr: string;
}

function cli(args: string[], env: Record<string, string> = {}): Run {
	const result = spawnSync(TSX, [CLI, ...args], {
		cwd: ROOT,
		encoding: 'utf8',
		env: { ...process.env, TZ: 'UTC', ...env },
	});

	if (result.error) throw result.error;

	return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function temp(label: string): string {
	return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), `one2md-cli-${label}-`));
}

function fixture(name: string): string {
	return nodePath.join(FIXTURES, name);
}

/** Temporary store directories the bounded path creates and must remove. */
function storeDirs(where: string): string[] {
	if (!nodeFs.existsSync(where)) return [];
	return nodeFs.readdirSync(where).filter(name => name.startsWith('one2md-pages-'));
}

// -- Both encodings, both paths ----------------------------------------------

for (const name of [DESKTOP, WEB]) {
	test(`the bounded CLI converts ${name} exactly as the eager CLI does`, () => {
		const bounded = temp('bounded');
		const eager = temp('eager');

		try {
			const boundedRun = cli([fixture(name), '-o', bounded, '--memory-budget', '1M']);
			const eagerRun = cli([fixture(name), '-o', eager]);

			assert.equal(boundedRun.status, 0, `bounded run failed: ${boundedRun.stderr}`);
			assert.equal(eagerRun.status, 0, `eager run failed: ${eagerRun.stderr}`);

			const boundedTree = readTree(bounded);
			assert.ok(boundedTree.size > 0, 'the bounded run wrote nothing');
			assert.deepEqual(
				[...boundedTree].map(([path, data]) => [path, data.toString('base64')]),
				[...readTree(eager)].map(([path, data]) => [path, data.toString('base64')]),
				'the two paths wrote different trees');

			// The budget line is the one thing the bounded run says that the
			// eager run does not, and it should say what it allocated.
			assert.match(boundedRun.stderr, /memory budget 1M: caches \d+K x3, window \d+K/);
		}
		finally {
			nodeFs.rmSync(bounded, { recursive: true, force: true });
			nodeFs.rmSync(eager, { recursive: true, force: true });
		}
	});
}

test('a section too large for the budget still converts, a page at a time', () => {
	// Under the minimum-plus-a-bit, every cache holds a page or two, so the
	// conversion is forced through the disk-backed path for everything.
	const tight = temp('tight');
	const roomy = temp('roomy');

	try {
		const tightRun = cli([fixture('handwriting_recognition.one'), '-o', tight, '--memory-budget', '1M']);
		const roomyRun = cli([fixture('handwriting_recognition.one'), '-o', roomy]);

		assert.equal(tightRun.status, 0, `the tight run failed: ${tightRun.stderr}`);
		assert.equal(roomyRun.status, 0, `the roomy run failed: ${roomyRun.stderr}`);

		assert.deepEqual(
			[...readTree(tight)].map(([path, data]) => [path, data.toString('base64')]),
			[...readTree(roomy)].map(([path, data]) => [path, data.toString('base64')]),
			'a 1M budget produced different output from an unbounded one');
	}
	finally {
		nodeFs.rmSync(tight, { recursive: true, force: true });
		nodeFs.rmSync(roomy, { recursive: true, force: true });
	}
});

// -- Dry run ------------------------------------------------------------------

test('a bounded dry run reports what it would write and writes nothing', () => {
	const out = temp('dry');

	try {
		nodeFs.rmSync(out, { recursive: true, force: true });

		const run = cli([fixture(DESKTOP), '-o', out, '--memory-budget', '8M', '--dry-run']);

		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /^Would write \d+ notes and \d+ attachments\n$/);
		assert.ok(!run.stdout.includes(out), 'a dry run named an output folder it would not write to');
		assert.ok(!nodeFs.existsSync(out), 'a dry run created the output folder');
	}
	finally {
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

// -- JSON ---------------------------------------------------------------------

test('the bounded --json report is byte-identical to the eager one', () => {
	const bounded = temp('json-bounded');
	const eager = temp('json-eager');

	try {
		const boundedRun = cli([fixture(DESKTOP), fixture(WEB), '-o', bounded, '--memory-budget', '2M', '--json', '-q']);
		const eagerRun = cli([fixture(DESKTOP), fixture(WEB), '-o', eager, '--json', '-q']);

		assert.equal(boundedRun.status, 0, boundedRun.stderr);
		assert.equal(eagerRun.status, 0, eagerRun.stderr);

		// The only difference is the output folder each was given.
		assert.equal(
			boundedRun.stdout.split(bounded).join('OUT'),
			eagerRun.stdout.split(eager).join('OUT'),
			'the two reports differ');
	}
	finally {
		nodeFs.rmSync(bounded, { recursive: true, force: true });
		nodeFs.rmSync(eager, { recursive: true, force: true });
	}
});

test('a bounded --json report groups its records by input', () => {
	const out = temp('json-groups');

	try {
		const run = cli([fixture(DESKTOP), fixture(WEB), '-o', out, '--memory-budget', '2M', '--json', '-q']);
		assert.equal(run.status, 0, run.stderr);

		const report = JSON.parse(run.stdout);

		assert.equal(report.ok, true);
		assert.equal(report.out, out);
		assert.equal(report.dryRun, false);
		assert.equal(report.reports.length, 2, 'two inputs should be two reports');

		const [first, second] = report.reports;
		assert.ok(first.input.endsWith(DESKTOP));
		assert.ok(second.input.endsWith(WEB));

		for (const group of report.reports) {
			assert.deepEqual(Object.keys(group),
				['input', 'notes', 'attachments', 'skipped', 'errors', 'cancelled'],
				'the report keys or their order changed');
			assert.ok(group.notes.length > 0, `${group.input} recorded no notes`);
			assert.equal(group.cancelled, false);
		}

		// Every recorded path exists, and no path is claimed by two inputs.
		const all = report.reports.flatMap((group: { notes: string[], attachments: string[] }) =>
			[...group.notes, ...group.attachments]);
		assert.equal(new Set(all).size, all.length, 'a path was recorded under two inputs');
		for (const path of all) {
			assert.ok(nodeFs.existsSync(nodePath.join(out, ...path.split('/'))), `${path} was reported but not written`);
		}
	}
	finally {
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

test('a bounded batch shares names across inputs, as one run should', () => {
	const inputs = temp('same-name');
	const out = temp('same-name-out');

	try {
		// The same section twice under different names: the notes inside collide
		// and the batch has to keep them apart.
		nodeFs.copyFileSync(fixture(DESKTOP), nodePath.join(inputs, 'one.one'));
		nodeFs.copyFileSync(fixture(DESKTOP), nodePath.join(inputs, 'two.one'));

		const run = cli([
			nodePath.join(inputs, 'one.one'), nodePath.join(inputs, 'two.one'),
			'-o', out, '--memory-budget', '2M', '--json', '-q',
		]);
		assert.equal(run.status, 0, run.stderr);

		const report = JSON.parse(run.stdout);
		const notes = report.reports.flatMap((group: { notes: string[] }) => group.notes);

		assert.equal(notes.length, 2, 'each input should have produced a note');
		assert.equal(new Set(notes).size, 2, 'two inputs wrote the same note path');
		for (const note of notes) {
			assert.ok(nodeFs.existsSync(nodePath.join(out, ...note.split('/'))), `${note} is missing`);
		}
	}
	finally {
		nodeFs.rmSync(inputs, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

// -- Budgets ------------------------------------------------------------------

test('a budget under the minimum is a usage error that says the minimum', () => {
	const run = cli([fixture(DESKTOP), '--memory-budget', '64K']);

	assert.equal(run.status, 2, 'a too-small budget should be a usage error');
	assert.match(run.stderr, /below the 1M minimum/);
	assert.match(run.stderr, /--memory-budget 1M or more/);
	assert.match(run.stderr, /Usage:/, 'a usage error should print the usage');
});

test('the minimum budget is exactly the smallest one that plans', () => {
	assert.throws(() => planBudget(MINIMUM_BUDGET_BYTES - 1), BudgetError);

	const budget = planBudget(MINIMUM_BUDGET_BYTES);
	assert.ok(budget.accountedBytes <= MINIMUM_BUDGET_BYTES,
		`${budget.accountedBytes} accounted against a ${MINIMUM_BUDGET_BYTES} budget`);
});

test('every planned budget accounts for itself without overrunning', () => {
	for (const total of [1024 * 1024, 3 * 1024 * 1024, 8 * 1024 * 1024, 512 * 1024 * 1024]) {
		const budget = planBudget(total);

		assert.ok(budget.accountedBytes <= total,
			`${total}: accounted ${budget.accountedBytes} exceeds the budget`);
		// A division that leaves most of the budget unspoken for is a bug of a
		// different kind: the user asked for it to be used.
		assert.ok(budget.accountedBytes >= total * 0.9,
			`${total}: only ${budget.accountedBytes} of it was allocated`);

		assert.ok(budget.indexCacheBytes >= budget.pageSize);
		assert.ok(budget.conversionCacheBytes >= budget.pageSize);
		assert.ok(budget.workspaceCacheBytes >= budget.pageSize);
		assert.ok(budget.windowBytes >= 64 * 1024);
		assert.match(describe(budget), /accounted/);
	}
});

test('a non-size budget is a usage error', () => {
	const run = cli([fixture(DESKTOP), '--memory-budget', 'lots']);

	assert.equal(run.status, 2);
	assert.match(run.stderr, /expects a size such as 512M or 4G/);
});

// -- Scope --------------------------------------------------------------------

test('a .onepkg named directly under a budget is refused before it is read', () => {
	const run = cli([fixture('makecab-lzx-notebook.onepkg'), '--memory-budget', '8M']);

	assert.equal(run.status, 2, 'an out-of-scope input should be a usage error');
	assert.match(run.stderr, /is a Cabinet archive of sections/);
	assert.match(run.stderr, /converts loose \.one sections only/);
	assert.match(run.stderr, /without --memory-budget/);
});

test('a .onepkg found by scanning a folder fails that input and not the run', () => {
	const inputs = temp('mixed');
	const out = temp('mixed-out');

	try {
		nodeFs.copyFileSync(fixture(DESKTOP), nodePath.join(inputs, 'loose.one'));
		nodeFs.copyFileSync(fixture('makecab-lzx-notebook.onepkg'), nodePath.join(inputs, 'packed.onepkg'));

		const run = cli([inputs, '-o', out, '--memory-budget', '8M', '--json', '-q']);

		assert.equal(run.status, 1, 'the run should fail, having failed an input');

		const report = JSON.parse(run.stdout);
		assert.equal(report.ok, false);
		assert.equal(report.reports.length, 2);

		const loose = report.reports.find((group: { input: string }) => group.input.endsWith('loose.one'));
		const packed = report.reports.find((group: { input: string }) => group.input.endsWith('packed.onepkg'));

		assert.deepEqual(loose.errors, [], 'the loose section should have converted');
		assert.ok(loose.notes.length > 0);

		assert.equal(packed.notes.length, 0);
		assert.equal(packed.errors.length, 1);
		assert.equal(packed.errors[0].code, 'ONE2MD_BOUNDED_SCOPE');
		assert.match(run.stderr, /converts loose \.one sections only/);
	}
	finally {
		nodeFs.rmSync(inputs, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

test('an archive wearing a .one name is refused on its magic bytes', () => {
	const inputs = temp('misnamed');
	const out = temp('misnamed-out');

	try {
		nodeFs.copyFileSync(fixture('makecab-lzx-notebook.onepkg'), nodePath.join(inputs, 'pretend.one'));

		const run = cli([nodePath.join(inputs, 'pretend.one'), '-o', out, '--memory-budget', '8M', '--json', '-q']);

		assert.equal(run.status, 1);

		const report = JSON.parse(run.stdout);
		assert.equal(report.reports[0].errors[0].code, 'ONE2MD_BOUNDED_SCOPE');
	}
	finally {
		nodeFs.rmSync(inputs, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

// -- Failures -----------------------------------------------------------------

test('a malformed section fails its input with a reason and an exit code', () => {
	const inputs = temp('malformed');
	const out = temp('malformed-out');

	try {
		// A plausible size of nothing in particular: not a OneNote header, and
		// not an archive either.
		nodeFs.writeFileSync(nodePath.join(inputs, 'broken.one'), Buffer.alloc(8192, 0x41));

		const run = cli([nodePath.join(inputs, 'broken.one'), '-o', out, '--memory-budget', '8M', '--json', '-q']);

		assert.equal(run.status, 1);

		const report = JSON.parse(run.stdout);
		const failure = report.reports[0].errors[0];

		assert.equal(report.ok, false);
		assert.equal(report.reports[0].notes.length, 0);
		assert.ok(['malformed', 'unsupported'].includes(failure.kind), `unexpected kind ${failure.kind}`);
		assert.ok(failure.message.length > 0);
	}
	finally {
		nodeFs.rmSync(inputs, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

test('a truncated section fails rather than reading past the end', () => {
	const inputs = temp('truncated');
	const out = temp('truncated-out');

	try {
		const whole = nodeFs.readFileSync(fixture(DESKTOP));
		nodeFs.writeFileSync(nodePath.join(inputs, 'half.one'), whole.subarray(0, Math.floor(whole.length / 3)));

		const run = cli([nodePath.join(inputs, 'half.one'), '-o', out, '--memory-budget', '8M', '--json', '-q']);

		assert.equal(run.status, 1);
		assert.equal(JSON.parse(run.stdout).ok, false);
	}
	finally {
		nodeFs.rmSync(inputs, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

test('a reader limit failure names the option that lifts it', () => {
	const out = temp('limit-out');

	try {
		const run = cli([fixture(DESKTOP), '-o', out, '--memory-budget', '8M', '--max-objects', '1']);

		assert.equal(run.status, 1);
		assert.match(run.stderr, /exceeds a safety limit/);
		assert.match(run.stderr, /--max-objects/);
	}
	finally {
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

test('an asset ceiling failure names --max-asset-bytes, and raising it converts', () => {
	const tight = temp('asset-tight');
	const raised = temp('asset-raised');

	try {
		const blocked = cli([
			fixture(DESKTOP), '-o', tight, '--memory-budget', '8M', '--max-asset-bytes', '16',
		]);

		assert.equal(blocked.status, 1);
		assert.match(blocked.stderr, /exceeds a safety limit/);
		assert.match(blocked.stderr, /--max-asset-bytes/);

		const run = cli([
			fixture(DESKTOP), '-o', raised, '--memory-budget', '8M', '--max-asset-bytes', '64M',
		]);

		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stderr, /\d+ notes/);
	}
	finally {
		nodeFs.rmSync(tight, { recursive: true, force: true });
		nodeFs.rmSync(raised, { recursive: true, force: true });
	}
});

test('--max-total-asset-bytes must be at least --max-asset-bytes', () => {
	const run = cli([
		fixture(DESKTOP), '--max-asset-bytes', '512M', '--max-total-asset-bytes', '64M',
	]);

	assert.equal(run.status, 2);
	assert.match(run.stderr, /--max-total-asset-bytes must be at least --max-asset-bytes/);
});

// -- Temporary directories ----------------------------------------------------

test('the stores clean up after themselves inside a supplied --temp-dir', () => {
	const root = temp('temp-root');
	const out = temp('temp-out');

	try {
		// A file of our own in the root, to check that a store removes only the
		// directory it made and never the root it was pointed at.
		nodeFs.writeFileSync(nodePath.join(root, 'keep.txt'), 'keep me');

		const run = cli([
			fixture(DESKTOP), '-o', out,
			'--memory-budget', '1M', '--temp-dir', root,
		]);

		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(storeDirs(root), [], 'a store left its temporary directory behind');
		assert.ok(nodeFs.existsSync(root), 'the supplied temporary root was removed');
		assert.equal(nodeFs.readFileSync(nodePath.join(root, 'keep.txt'), 'utf8'), 'keep me',
			'a store touched something it did not create');
	}
	finally {
		nodeFs.rmSync(root, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

test('a failing conversion still cleans up its temporary directories', () => {
	const root = temp('temp-fail-root');
	const inputs = temp('temp-fail-in');
	const out = temp('temp-fail-out');

	try {
		nodeFs.writeFileSync(nodePath.join(inputs, 'broken.one'), Buffer.alloc(4096, 0x42));

		const run = cli([
			nodePath.join(inputs, 'broken.one'), '-o', out,
			'--memory-budget', '1M', '--temp-dir', root, '-q',
		]);

		assert.equal(run.status, 1);
		assert.deepEqual(storeDirs(root), [], 'a failed run left a temporary directory behind');
	}
	finally {
		nodeFs.rmSync(root, { recursive: true, force: true });
		nodeFs.rmSync(inputs, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

test('--temp-dir alone selects the bounded path', () => {
	const root = temp('temp-only-root');
	const out = temp('temp-only-out');
	const eager = temp('temp-only-eager');

	try {
		const run = cli([fixture(DESKTOP), '-o', out, '--temp-dir', root]);
		const eagerRun = cli([fixture(DESKTOP), '-o', eager]);

		assert.equal(run.status, 0, run.stderr);
		assert.equal(eagerRun.status, 0, eagerRun.stderr);
		assert.match(run.stderr, /memory budget/, '--temp-dir should have selected the bounded path');
		assert.deepEqual(storeDirs(root), []);
		assert.deepEqual(
			[...readTree(out)].map(([path, data]) => [path, data.toString('base64')]),
			[...readTree(eager)].map(([path, data]) => [path, data.toString('base64')]));
	}
	finally {
		nodeFs.rmSync(root, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
		nodeFs.rmSync(eager, { recursive: true, force: true });
	}
});

test('an unwritable --temp-dir is a usage error that says what to do', () => {
	const root = temp('temp-locked');
	const locked = nodePath.join(root, 'locked');

	try {
		nodeFs.mkdirSync(locked);
		nodeFs.chmodSync(locked, 0o500);

		const run = cli([fixture(DESKTOP), '--temp-dir', nodePath.join(locked, 'inside')]);

		assert.equal(run.status, 2);
		assert.match(run.stderr, /cannot be written to/);
		assert.match(run.stderr, /Point --temp-dir somewhere writable/);
	}
	finally {
		nodeFs.chmodSync(locked, 0o700);
		nodeFs.rmSync(root, { recursive: true, force: true });
	}
});

test('a .onex named directly under a budget is refused on its name alone', () => {
	const inputs = temp('onex');

	try {
		// Empty, deliberately: the refusal happens before the file is opened,
		// so there is nothing here for it to have looked at.
		nodeFs.writeFileSync(nodePath.join(inputs, 'notebook.onex'), '');

		const run = cli([nodePath.join(inputs, 'notebook.onex'), '--memory-budget', '8M']);

		assert.equal(run.status, 2);
		assert.match(run.stderr, /is a compound file holding a notebook/);
	}
	finally {
		nodeFs.rmSync(inputs, { recursive: true, force: true });
	}
});

test('a compound file wearing a .one name is refused for what it is', () => {
	const inputs = temp('compound');
	const out = temp('compound-out');

	try {
		const compound = Buffer.alloc(4096);
		Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(compound);
		nodeFs.writeFileSync(nodePath.join(inputs, 'pretend.one'), compound);

		const run = cli([nodePath.join(inputs, 'pretend.one'), '-o', out, '--memory-budget', '8M', '--json', '-q']);

		assert.equal(run.status, 1);

		const failure = JSON.parse(run.stdout).reports[0].errors[0];
		assert.equal(failure.code, 'ONE2MD_BOUNDED_SCOPE');
		assert.match(failure.message, /is a compound file holding a notebook/);
	}
	finally {
		nodeFs.rmSync(inputs, { recursive: true, force: true });
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

// -- Resource lifecycle -------------------------------------------------------

test('closers release everything, newest first, whatever happens', () => {
	const closed: string[] = [];
	const closers = new Closers();

	closers.add('first', () => closed.push('first'));
	const releaseSecond = closers.add('second', () => closed.push('second'));
	closers.add('third', () => closed.push('third'));

	// Releasing one early takes it out of the stack rather than leaving it to
	// be closed twice.
	releaseSecond();
	assert.deepEqual(closed, ['second']);

	closers.closeAll();
	assert.deepEqual(closed, ['second', 'third', 'first']);

	// Idempotent, because a signal handler and a `finally` can both reach it.
	closers.closeAll();
	assert.deepEqual(closed, ['second', 'third', 'first']);
});

test('one closer that throws does not strand the rest', () => {
	const closed: string[] = [];
	const closers = new Closers();

	closers.add('quiet', () => closed.push('quiet'));
	closers.add('loud', () => { throw new Error('nope'); });
	closers.add('also quiet', () => closed.push('also quiet'));

	closers.closeAll();

	assert.deepEqual(closed, ['also quiet', 'quiet'],
		'a failing close stopped the others');
});

// -- Listing ------------------------------------------------------------------

test('a bounded --list names the loose section without reading it whole', () => {
	const run = cli([fixture(DESKTOP), '--memory-budget', '8M', '--list', '--json']);

	assert.equal(run.status, 0, run.stderr);

	const listing = JSON.parse(run.stdout);
	assert.equal(listing.length, 1);
	assert.equal(listing[0].sections.length, 1);
	assert.equal(listing[0].sections[0].name, DESKTOP);
	assert.equal(listing[0].sections[0].title, 'testOneNote');
	assert.deepEqual(listing[0].sections[0].groups, []);
});

test('a bounded --list refuses an archive it is pointed at', () => {
	const inputs = temp('list-mixed');

	try {
		nodeFs.copyFileSync(fixture('makecab-lzx-notebook.onepkg'), nodePath.join(inputs, 'packed.onepkg'));

		const run = cli([inputs, '--memory-budget', '8M', '--list', '--json']);

		assert.equal(run.status, 1);
		assert.match(JSON.parse(run.stdout)[0].error, /converts loose \.one sections only/);
	}
	finally {
		nodeFs.rmSync(inputs, { recursive: true, force: true });
	}
});

// -- The legacy path is untouched ---------------------------------------------

test('without a budget the CLI still takes a .onepkg', () => {
	const out = temp('legacy');

	try {
		const run = cli([fixture('makecab-lzx-notebook.onepkg'), '-o', out, '-q']);

		assert.equal(run.status, 0, run.stderr);
		assert.ok(readTree(out).size > 0, 'the legacy path wrote nothing');
	}
	finally {
		nodeFs.rmSync(out, { recursive: true, force: true });
	}
});

// -- Cancellation -------------------------------------------------------------

test('a cancelled bounded run exits 130, says so, and cleans up after itself', async () => {
	const out = temp('cancel-out');
	const tempRoot = temp('cancel-temp');

	try {
		// The section is small, so a signal sent after the process starts would
		// usually arrive after it finished. `ONE2MD_TEST_CANCEL_AFTER` makes the
		// cancellation deterministic: the run stops after that many checks.
		const run = cli(
			[fixture(DESKTOP), '-o', out, '--memory-budget', '1M', '--temp-dir', tempRoot, '--json'],
			{ ONE2MD_TEST_CANCEL_AFTER: '3' });

		assert.equal(run.status, 130,
			`a cancelled run must not exit 0 or 1; got ${run.status}: ${run.stderr}`);

		const report = JSON.parse(run.stdout);
		assert.equal(report.ok, false, 'a cancelled run is not ok');
		assert.equal(report.reports[0].cancelled, true, 'the group should be marked cancelled');

		// Nothing recorded that is not on disk, and nothing on disk that is not
		// recorded — which is what a committed partial note would break.
		const written = nodeFs.existsSync(out)
			? nodeFs.readdirSync(out, { recursive: true })
				.map(String)
				.filter(name => name.endsWith('.md'))
				.map(name => name.split(nodePath.sep).join('/'))
			: [];

		assert.deepEqual(
			written.sort(),
			[...report.reports[0].notes].sort(),
			'the notes on disk and the notes in the report should be the same set');

		assert.deepEqual(storeDirs(tempRoot), [],
			'a cancelled run must still remove its temporary stores');
	}
	finally {
		nodeFs.rmSync(out, { recursive: true, force: true });
		nodeFs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

test('a cancelled run during a large note removes the partial file', () => {
	const out = temp('cancel-large-out');
	const tempRoot = temp('cancel-large-temp');

	try {
		// One check: the very first element of the very first page. The note
		// has been opened and its front matter written by then, so the file
		// exists on disk at the moment of cancellation and has to be removed.
		const run = cli(
			[fixture(WEB), '-o', out, '--memory-budget', '1M', '--temp-dir', tempRoot, '--json'],
			{ ONE2MD_TEST_CANCEL_AFTER: '1' });

		assert.equal(run.status, 130, `expected 130, got ${run.status}: ${run.stderr}`);

		const report = JSON.parse(run.stdout);
		assert.deepEqual(report.reports[0].notes, [],
			'no note completed, so none should be reported');

		const leftover = nodeFs.existsSync(out)
			? nodeFs.readdirSync(out, { recursive: true }).map(String).filter(name => name.endsWith('.md'))
			: [];

		assert.deepEqual(leftover, [],
			`a partial note was left on disk: ${leftover.join(', ')}`);
		assert.deepEqual(storeDirs(tempRoot), []);
	}
	finally {
		nodeFs.rmSync(out, { recursive: true, force: true });
		nodeFs.rmSync(tempRoot, { recursive: true, force: true });
	}
});

// -- Discovery and the report, off the heap ----------------------------------

test('a folder of many sections is walked lazily and reported from the store', () => {
	const inputs = temp('many-in');
	const out = temp('many-out');
	const tempRoot = temp('many-temp');

	try {
		// Enough copies that an array of paths, an array of groups and an array
		// of per-input reports would all be visible, and nested so the walk has
		// to recurse.
		const copies = 60;
		const source = nodeFs.readFileSync(fixture(DESKTOP));

		for (let index = 0; index < copies; index++) {
			const dir = nodePath.join(inputs, `folder-${String(index % 6).padStart(2, '0')}`);
			nodeFs.mkdirSync(dir, { recursive: true });
			nodeFs.writeFileSync(nodePath.join(dir, `section-${String(index).padStart(3, '0')}.one`), source);
		}

		const run = cli([inputs, '-o', out, '--memory-budget', '2M', '--temp-dir', tempRoot, '--json']);
		assert.equal(run.status, 0, run.stderr);

		const report = JSON.parse(run.stdout);
		assert.equal(report.reports.length, copies, 'every discovered section should have a group');

		// The order the walk produced, which decides which of two sections of
		// the same name keeps the plain file name — so it has to be the sorted
		// one and not whatever the filesystem returned.
		const inputsInOrder = report.reports.map((group: { input: string }) => group.input);
		assert.deepEqual(inputsInOrder, [...inputsInOrder].sort(),
			'the walk should visit sorted paths, so the output names are stable');

		// Shared naming across the batch survived the move to the store: sixty
		// sections of the same name means sixty distinct folders.
		const folders = new Set(report.reports.flatMap(
			(group: { notes: string[] }) => group.notes.map(note => note.split('/')[0])));
		assert.equal(folders.size, copies, 'each section should have claimed its own folder');

		assert.deepEqual(storeDirs(tempRoot), []);
	}
	finally {
		for (const path of [inputs, out, tempRoot]) nodeFs.rmSync(path, { recursive: true, force: true });
	}
});

test('the bounded run holds no per-input state of its own', () => {
	// The claim under test is structural rather than measured: `runBounded`
	// returns a count and the groups come from the workspace store. If either
	// went back to an array this stops compiling, which is the point.
	const shape = nodeFs.readFileSync(nodePath.join(ROOT, 'src/stream/run.ts'), 'utf8');

	assert.doesNotMatch(shape, /ReportGroup\[\]/,
		'runBounded should not collect groups into an array');
	assert.match(shape, /workspace\.recordGroup\(group\)/,
		'groups should go to the workspace store');
	assert.match(shape, /files: Iterable<string>/,
		'the inputs should be taken as a walk, not a finished list');
});

test('a real SIGINT stops the run and leaves only whole notes', async () => {
	// Against the built bundle, not the sources. `tsx` compiles in a child
	// process, so a signal sent to it kills the wrapper and never reaches the
	// converter — which is how a signal path can look tested and be untested.
	// This is also the artifact a user actually runs.
	if (!nodeFs.existsSync(BUNDLE)) return;

	const inputs = temp('signal-in');
	const complete = temp('signal-whole');
	const out = temp('signal-out');
	const tempRoot = temp('signal-temp');

	try {
		// Enough sections that the run lasts long enough to interrupt, each
		// under its own name so its notes land in their own folder and can be
		// compared one for one against the complete run.
		const source = nodeFs.readFileSync(fixture(DESKTOP));
		for (let index = 0; index < 300; index++) {
			nodeFs.writeFileSync(
				nodePath.join(inputs, `section-${String(index).padStart(3, '0')}.one`), source);
		}

		// The oracle: the same conversion, uninterrupted.
		const whole = cli([inputs, '-o', complete, '--memory-budget', '2M', '-q']);
		assert.equal(whole.status, 0, whole.stderr);

		const child = spawn(
			process.execPath,
			[BUNDLE, inputs, '-o', out, '--memory-budget', '2M', '--temp-dir', tempRoot],
			{ cwd: ROOT, env: { ...process.env, TZ: 'UTC' } });

		let noise = '';
		child.stderr.on('data', chunk => { noise += String(chunk); });
		child.stdout.on('data', () => {});

		const status = await new Promise<number | null>(resolve => {
			child.on('exit', code => resolve(code));

			// Once the run is properly under way, so the interruption lands
			// mid-section rather than before anything has been opened.
			const nudge = () => {
				if (!noise.includes('section-01')) {
					setTimeout(nudge, 10);
					return;
				}

				child.kill('SIGINT');
			};

			setTimeout(nudge, 20);
		});

		assert.equal(status, 130, `a signalled run should exit 130, not ${status}:\n${noise}`);
		assert.match(noise, /Cancelling/, 'the run should say it is stopping');

		const left = nodeFs.readdirSync(out, { recursive: true })
			.map(String)
			.filter(name => name.endsWith('.md'));

		assert.ok(left.length > 0, 'the run was interrupted before it wrote anything to compare');
		assert.ok(left.length < 300, `all 300 notes were written, so nothing was interrupted`);

		// The claim: every note left on disk is a whole note. One that was open
		// when the run stopped would differ from what the complete run wrote,
		// which makes this checkable without knowing where the signal landed.
		for (const name of left) {
			const expected = nodePath.join(complete, name);
			assert.ok(nodeFs.existsSync(expected), `${name} is not a file the complete run produced`);
			assert.deepEqual(
				nodeFs.readFileSync(nodePath.join(out, name)),
				nodeFs.readFileSync(expected),
				`${name} was left half written`);
		}

		assert.deepEqual(storeDirs(tempRoot), [],
			'a signalled run should still have removed its temporary stores');
	}
	finally {
		for (const path of [inputs, complete, out, tempRoot]) {
			nodeFs.rmSync(path, { recursive: true, force: true });
		}
	}
});

test('a forced exit releases every open file and store at once', async () => {
	// The forced branch of the signal handler is `closers.closeAll()` followed
	// by `process.exit`, and it cannot be reached from outside: two signals
	// sent close enough together to catch the process mid-note are coalesced
	// by the operating system into one delivery, and one delivery is the
	// cooperative path. So the composition is exercised here instead — the
	// same registrations, released the same way, with nothing mocked.
	const root = temp('forced-root');
	const out = temp('forced-out');

	try {
		const closers = new Closers();
		const sink = new FsSink(out, false);
		const store = new PagedKeyValueStore({
			pageSize: 4096, cacheBytes: 4096, bucketCount: 64, tempDirectory: root,
		});

		closers.add('the workspace store', () => store.close());
		closers.add('the open files', () => sink.abortAll());

		// Mid-note and mid-asset, which is the state a forced exit finds.
		const note = await sink.open('page/note.md');
		const asset = await sink.open('page/attachments/image.png');

		await note.write(new TextEncoder().encode('---\ntitle: "half"'));
		await asset.write(new Uint8Array([1, 2, 3]));

		assert.equal(storeDirs(root).length, 1, 'the store should have a directory to remove');
		assert.equal(
			nodeFs.readdirSync(out, { recursive: true }).map(String)
				.filter(name => name.endsWith('.md')).length,
			1,
			'the partial note should exist, which is what needs removing');

		closers.closeAll();

		assert.deepEqual(storeDirs(root), [], 'the store directory should be gone');
		assert.deepEqual(
			nodeFs.readdirSync(out, { recursive: true }).map(String)
				.filter(name => name.endsWith('.md') || name.endsWith('.png')),
			[],
			'the files still being written should have been deleted');

		// And again, because an `exit` handler runs after a second signal has
		// already done this.
		closers.closeAll();
	}
	finally {
		for (const path of [root, out]) nodeFs.rmSync(path, { recursive: true, force: true });
	}
});

test('the bounded run registers its stores and sink for a forced exit', () => {
	// Structural, because what matters is that the registration exists at all:
	// a store opened without it is a temporary directory nothing will remove
	// when the process is forced out.
	const shape = nodeFs.readFileSync(nodePath.join(ROOT, 'src/stream/run.ts'), 'utf8');

	assert.match(shape, /onOpen: \(what, close\) => closers\.add/,
		'a section should register the stores it opens');
	assert.match(shape, /sink\.abortAll\(\)/,
		'the sink should be registered so its open files are deleted');
	assert.match(shape, /releaseSink\(\)/,
		'and deregistered when the input finishes');
});

test('a wide directory is walked in sorted order without listing it', () => {
	const inputs = temp('wide-in');
	const out = temp('wide-out');

	try {
		// Enough entries to catch a scan that loses one or repeats one, in an
		// order no filesystem will hand back sorted, and most of them not
		// convertible so the walk has to skip as well as find. Kept to eight
		// hundred because the scan is quadratic by design and the suite should
		// not pay seconds for a property a few hundred entries establish.
		const total = 800;
		const source = nodeFs.readFileSync(fixture(DESKTOP));
		const expected: string[] = [];

		for (let index = 0; index < total; index++) {
			// Names chosen so lexicographic order is not creation order.
			const stem = `${String((index * 7919) % total).padStart(5, '0')}-s`;
			if (index % 3 === 0) {
				nodeFs.writeFileSync(nodePath.join(inputs, `${stem}.one`), source);
				expected.push(`${stem}.one`);
			}
			else {
				// Not convertible, so the walk has to skip it rather than
				// stumble on it.
				nodeFs.writeFileSync(nodePath.join(inputs, `${stem}.txt`), 'ignore me');
			}
		}

		expected.sort((left, right) => left.localeCompare(right));

		const run = cli([inputs, '-o', out, '--memory-budget', '2M', '--json', '-q']);
		assert.equal(run.status, 0, run.stderr);

		const report = JSON.parse(run.stdout);
		const visited = report.reports.map(
			(group: { input: string }) => nodePath.basename(group.input));

		assert.equal(visited.length, expected.length,
			'the walk should find every convertible file exactly once');
		assert.deepEqual(visited, expected,
			'and visit them in the order the old sorted listing produced');
	}
	finally {
		for (const path of [inputs, out]) nodeFs.rmSync(path, { recursive: true, force: true });
	}
});

test('the bounded walk never lists a whole directory', () => {
	// Structural, because the cost being avoided is invisible in a result: a
	// `readdirSync` here works perfectly and allocates an array proportional to
	// however many files someone put in the folder.
	const shape = nodeFs.readFileSync(nodePath.join(ROOT, 'src/cli.ts'), 'utf8');
	const walk = shape
		.slice(shape.indexOf('function* discover'), shape.indexOf('function compareNames'))
		// Comments explain what is not being done, and saying so is not doing
		// it. Only the code counts.
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/\/\/.*$/gm, '');

	assert.doesNotMatch(walk, /readdirSync/,
		'the walk should use opendirSync, which yields one entry at a time');
	assert.match(walk, /opendirSync/);
});
