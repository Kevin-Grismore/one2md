/**
 * Does a fixed memory budget hold as the input grows?
 *
 * The committed fixtures are all under two hundred kilobytes. Nothing about
 * memory can honestly be claimed from them: at that size the process is
 * ninety-nine per cent Node, and a conversion that quietly held the whole file
 * would look identical to one that held a page. So this generates sections at
 * increasing sizes, converts each in its own child process under one budget,
 * and reports what happened.
 *
 * What it checks, in order of how much it proves:
 *
 *   1. **The accounted high water is flat.** Every buffer the budget covers
 *      reports its own high-water mark, and the total should be the same at
 *      the largest size as at the smallest. This is the claim, and it is the
 *      one measurement that is not noise.
 *
 *   2. **Output is identical to the eager path.** A conversion that saves
 *      memory by dropping content is not a conversion. Each section is done
 *      both ways and the trees are compared by digest, note by note.
 *
 *   3. **The conversion completes inside a hard V8 heap cap.** Every size is
 *      converted again under `--max-old-space-size`, which V8 enforces by
 *      aborting rather than by growing. A path that read the file in would die
 *      on the largest size and survive the smallest; surviving all of them at
 *      one cap is the claim stated as something that can fail — and unlike the
 *      accounting in (1), it can fail because of an allocation nobody thought
 *      to account for. On by default for that reason; `--heap-cap 0` turns it
 *      off for a timing run, where the extra process per size dominates.
 *
 *   4. **Peak RSS does not track the input.** Weak evidence and reported as
 *      such: RSS includes the runtime, the JIT and whatever V8 has not yet
 *      collected, so it is noisy and its floor is high — an idle Node is
 *      already tens of megabytes. It is here because a real regression would
 *      show up in it, not because a number in that column means much.
 *
 *   node scripts/bench-bounded.mjs [--budget 8M] [--pages 50,200,800]
 *                                  [--heap-cap 96 | --heap-cap 0] [--keep] [--json]
 *
 * Requires .NET and OfficeIMO to generate the sections. Without them there is
 * nothing to measure and it exits 0 with a note saying so, because a developer
 * without .NET should not see a red run for a tool they cannot use. The unit
 * and stress tests do not depend on any of this and always run.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oracle = path.join(root, 'scripts', 'oracle');
const tsx = path.join(root, 'node_modules', '.bin', 'tsx');
const cli = path.join(root, 'src', 'cli.ts');

const args = process.argv.slice(2);
const json = args.includes('--json');
const keep = args.includes('--keep');
const budget = flag('--budget') ?? '8M';
/**
 * The heap every bounded conversion is made to fit inside.
 *
 * On by default, because the alternative — the converter's own accounting —
 * cannot see an allocation nobody thought to account for, and those are the
 * ones worth finding. `--heap-cap 0` turns it off for a timing run, where the
 * extra process per size is most of the wall clock.
 */
const heapCap = flag('--heap-cap') === undefined ? 96 : Number(flag('--heap-cap')) || undefined;
const pages = (flag('--pages') ?? '50,200,800').split(',').map(Number).filter(n => n > 0);

function flag(name) {
	const at = args.indexOf(name);
	return at >= 0 && at + 1 < args.length ? args[at + 1] : undefined;
}

function say(line) {
	if (!json) process.stdout.write(`${line}\n`);
}

/**
 * Whether the sections can be generated at all.
 *
 * Two separate things: a `dotnet` on the path, and an oracle project that
 * builds. The second can fail on its own — OfficeIMO is restored from the
 * network — so it is checked rather than assumed.
 */
function generatorAvailable() {
	const dotnet = spawnSync('dotnet', ['--version'], { encoding: 'utf8' });
	if (dotnet.error || dotnet.status !== 0) return 'no dotnet on the path';

	const build = spawnSync('dotnet', ['build', '-v', 'q', '--nologo'], { cwd: oracle, encoding: 'utf8' });
	if (build.status !== 0) {
		return `the oracle project does not build: ${(build.stdout || build.stderr || '').trim().split('\n').pop()}`;
	}

	return undefined;
}

function digestTree(dir) {
	const files = [];

	const walk = current => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else {
				files.push([
					path.relative(dir, full).split(path.sep).join('/'),
					createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
				]);
			}
		}
	};

	if (fs.existsSync(dir)) walk(dir);
	return files;
}

/**
 * Peak resident set of a child, where the platform will say.
 *
 * `/usr/bin/time -l` on macOS and `-v` on Linux report a child's maximum
 * resident set, which is the only portable-ish way to get a *peak* rather than
 * a sample — asking the process itself only ever sees where it happens to be
 * when asked. Where neither works this returns undefined and the run carries
 * on without it, since the accounting is the real check.
 */
function withPeakRss(command, commandArgs, options) {
	const time = process.platform === 'darwin'
		? ['/usr/bin/time', '-l', command, ...commandArgs]
		: process.platform === 'linux'
			? ['/usr/bin/time', '-v', command, ...commandArgs]
			: undefined;

	if (!time || !fs.existsSync(time[0])) {
		const plain = spawnSync(command, commandArgs, options);
		return { result: plain, peakRssBytes: undefined };
	}

	const result = spawnSync(time[0], time.slice(1), options);
	const text = result.stderr ?? '';

	// macOS reports bytes; GNU time reports kilobytes.
	const mac = /^\s*(\d+)\s+maximum resident set size/m.exec(text);
	const gnu = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(text);
	const peakRssBytes = mac ? Number(mac[1]) : gnu ? Number(gnu[1]) * 1024 : undefined;

	// The measured command's own stderr is in there too; the caller wants that
	// and not the accounting lines `time` appended.
	return { result, peakRssBytes };
}

function convert(input, out, extra) {
	fs.rmSync(out, { recursive: true, force: true });

	const { result, peakRssBytes } = withPeakRss(tsx, [cli, input, '-o', out, '--json', '-q', ...extra], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, TZ: 'UTC' },
		maxBuffer: 64 * 1024 * 1024,
	});

	if (result.status !== 0) {
		throw new Error(`converting ${path.basename(input)} exited ${result.status}: ${result.stderr}`);
	}

	return { report: JSON.parse(result.stdout), peakRssBytes };
}

function format(bytes) {
	if (bytes === undefined) return '     —';
	return `${(bytes / 1024 / 1024).toFixed(1)}M`.padStart(6);
}

const unavailable = generatorAvailable();
if (unavailable) {
	const note = `bench-bounded: skipped — ${unavailable}.`;
	if (json) process.stdout.write(`${JSON.stringify({ skipped: true, reason: unavailable })}\n`);
	else process.stdout.write(`${note}\nThe unit and stress tests cover the bounded path without it.\n`);
	process.exit(0);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'one2md-bench-'));
const sections = path.join(work, 'sections');

try {
	say(`generating sections at ${pages.join(', ')} pages, both encodings`);

	const generate = spawnSync('dotnet', ['run', '--', 'write', sections, '--sections', ...pages.map(String)],
		{ cwd: oracle, encoding: 'utf8' });
	if (generate.status !== 0) throw new Error(`generating sections failed: ${generate.stderr}`);

	const inputs = fs.readdirSync(sections).filter(name => name.endsWith('.one')).sort();
	if (inputs.length === 0) throw new Error('the generator wrote no sections');

	say('');
	say('encoding  pages  input    accounted  observed   bounded RSS  eager RSS   notes  parity'
		+ (heapCap ? `  ${heapCap}M heap` : ''));

	const rows = [];

	for (const name of inputs) {
		const input = path.join(sections, name);
		const [, encoding, pageText] = /^bench-(desktop|web)-(\d+)\.one$/.exec(name) ?? [];
		const inputBytes = fs.statSync(input).size;

		const boundedOut = path.join(work, `bounded-${name}`);
		const eagerOut = path.join(work, `eager-${name}`);

		const bounded = convert(input, boundedOut, ['--memory-budget', budget, '--temp-dir', work]);
		const eager = convert(input, eagerOut, []);

		const boundedTree = digestTree(boundedOut);
		const eagerTree = digestTree(eagerOut);
		const parity = JSON.stringify(boundedTree) === JSON.stringify(eagerTree);

		const noteCount = bounded.report.reports[0].notes.length;
		const eagerNoteCount = eager.report.reports[0].notes.length;

		// The accounting the converter itself keeps, read back out of the run.
		const accounting = accountFor(input, budget, work);

		// The same conversion again, this time with V8 forbidden to grow past a
		// ceiling it enforces by aborting. Nothing about the output is checked
		// here — the run above did that — only whether it finished.
		const withinHeapCap = heapCap === undefined
			? undefined
			: survivesHeapCap(input, boundedOut, heapCap);

		rows.push({
			encoding,
			pages: Number(pageText),
			inputBytes,
			accountedBytes: accounting.highWaterBytes,
			observedValueBytes: accounting.valueObservedBytes,
			boundedPeakRssBytes: bounded.peakRssBytes,
			eagerPeakRssBytes: eager.peakRssBytes,
			noteCount,
			parity,
			counts: noteCount === eagerNoteCount,
			withinHeapCap,
		});

		say(`${encoding.padEnd(9)} ${String(pageText).padStart(5)}  ${format(inputBytes)}  `
			+ `${format(accounting.highWaterBytes)}     ${String(accounting.valueObservedBytes).padStart(7)}   `
			+ `${format(bounded.peakRssBytes)}       ${format(eager.peakRssBytes)}  `
			+ `${String(noteCount).padStart(5)}  ${parity ? 'same' : 'DIFFERS'}`
			+ (heapCap ? `  ${withinHeapCap ? 'fits' : 'OUT OF MEMORY'}` : ''));

		if (!keep) {
			fs.rmSync(boundedOut, { recursive: true, force: true });
			fs.rmSync(eagerOut, { recursive: true, force: true });
		}
	}

	const problems = check(rows);

	if (json) process.stdout.write(`${JSON.stringify({ skipped: false, budget, rows, problems }, null, 2)}\n`);
	else {
		say('');
		if (problems.length === 0) {
			say(`all ${rows.length} sections: output identical to the eager path, `
				+ `accounted high water flat under a ${budget} budget.`);
		}
		else for (const problem of problems) say(`FAIL ${problem}`);
	}

	process.exit(problems.length === 0 ? 0 : 1);
}
finally {
	if (keep) process.stderr.write(`kept ${work}\n`);
	else fs.rmSync(work, { recursive: true, force: true });
}

/**
 * The converter's own accounting for one section, from a child process.
 *
 * Run separately from the timed conversion above so that `/usr/bin/time` is
 * measuring a plain CLI run and not one carrying a reporter. It is the same
 * work either way; only the reporting differs.
 */
function accountFor(input, budgetText, tempDir) {
	const script = `
		import { planBudget } from '${root}/src/stream/budget.ts';
		import { ResidentAccount } from '${root}/src/stream/account.ts';
		import { Closers, runBounded } from '${root}/src/stream/run.ts';
		import { DEFAULT_READER_OPTIONS } from '${root}/src/onenote-file/onestore/options.ts';

		// Wrapped, because tsx compiles --eval as CommonJS and a top-level
		// await is not allowed there.
		async function main() {
			const account = new ResidentAccount();
			const closers = new Closers();
			const budget = planBudget(${sizeOf(budgetText)}, ${JSON.stringify(tempDir)});

			try {
				await runBounded({
					files: [${JSON.stringify(input)}],
					out: 'unused',
					budget,
					dryRun: true,
					overwrite: false,
					readerOptions: DEFAULT_READER_OPTIONS,
					convert: { writeAttachments: true, frontmatter: true },
					account,
				}, closers);

				const reading = account.read();
				process.stdout.write(JSON.stringify({ ...reading, highWaterBytes: account.peakHighWaterBytes }));
			}
			finally {
				closers.closeAll();
			}
		}

		main().catch(error => { process.stderr.write(String(error?.stack ?? error)); process.exit(1); });
	`;

	const result = spawnSync(tsx, ['--eval', script], {
		cwd: root,
		encoding: 'utf8',
		env: { ...process.env, TZ: 'UTC' },
	});

	if (result.status !== 0) throw new Error(`accounting for ${path.basename(input)} failed: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

function sizeOf(text) {
	const match = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(text.trim());
	if (!match) throw new Error(`--budget expects a size such as 8M, not "${text}"`);
	const scale = { '': 1, k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[match[2].toLowerCase()];
	return Math.floor(Number(match[1]) * scale);
}

/**
 * What would make this a failing run.
 *
 * The flatness test is the point: the accounted high water at the largest size
 * must not exceed the smallest by more than a page of slack, per encoding.
 * Slack rather than exact equality because a cache's high water depends on how
 * many distinct pages a section's records happen to touch, and one page either
 * way is not growth — growth with the input would be a multiple, not a page.
 */
function check(rows) {
	const problems = [];

	for (const row of rows) {
		if (!row.parity) problems.push(`${row.encoding} ${row.pages}: bounded output differs from eager output`);
		if (!row.counts) problems.push(`${row.encoding} ${row.pages}: note counts differ between the two paths`);
		if (row.noteCount === 0) problems.push(`${row.encoding} ${row.pages}: no notes were written`);

		if (row.accountedBytes > sizeOf(budget)) {
			problems.push(`${row.encoding} ${row.pages}: accounted ${row.accountedBytes} bytes, over the budget`);
		}
		if (row.observedValueBytes >= row.accountedBytes) {
			problems.push(`${row.encoding} ${row.pages}: observed values fill the whole accounting`);
		}
		if (row.withinHeapCap === false) {
			problems.push(
				`${row.encoding} ${row.pages}: ran out of heap under --max-old-space-size=${heapCap}, `
				+ 'so something is being held that should not be');
		}
	}

	for (const encoding of ['desktop', 'web']) {
		const series = rows.filter(row => row.encoding === encoding).sort((a, b) => a.pages - b.pages);
		if (series.length < 2) continue;

		const smallest = series[0];
		const largest = series[series.length - 1];
		const slack = 64 * 1024;

		if (largest.accountedBytes > smallest.accountedBytes + slack) {
			problems.push(
				`${encoding}: accounted high water grew from ${smallest.accountedBytes} bytes at `
				+ `${smallest.pages} pages to ${largest.accountedBytes} at ${largest.pages} — `
				+ 'the budget is tracking the input');
		}

		const growth = largest.inputBytes / smallest.inputBytes;
		say(`${encoding}: input grew ${growth.toFixed(1)}x, accounted high water `
			+ `${largest.accountedBytes === smallest.accountedBytes ? 'did not move' : `moved ${largest.accountedBytes - smallest.accountedBytes} bytes`}`);
	}

	return problems;
}

/**
 * Whether the conversion finishes with V8's old space capped.
 *
 * A cap V8 enforces by aborting, which is what makes this an assertion rather
 * than a measurement: a conversion holding a thirty-five megabyte section will
 * not fit in sixty-four megabytes of heap, and there is no way for it to
 * almost fit. The floor is Node's own — the runtime and the loaded module
 * graph need tens of megabytes before any OneNote is read — so the cap is
 * about where the line stops moving, not about the budget.
 */
function survivesHeapCap(input, out, capMegabytes) {
	fs.rmSync(out, { recursive: true, force: true });

	// The cap goes in the environment, not on the command line. `tsx` compiles
	// in a child process of its own, and that child inherits the environment
	// but not the parent's V8 flags — so a flag passed to the wrapper caps the
	// wrapper and nothing else, which looks identical to a cap being honoured.
	const result = spawnSync(
		tsx,
		[cli, input, '-o', out, '--memory-budget', budget, '--temp-dir', work, '-q'],
		{
			cwd: root,
			encoding: 'utf8',
			env: {
				...process.env,
				TZ: 'UTC',
				NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${capMegabytes}`.trim(),
			},
			maxBuffer: 16 * 1024 * 1024,
		});

	if (result.status === 0) return true;

	// Distinguish running out of heap from failing for some other reason,
	// because only the first one is what this is asking about.
	if (/heap out of memory|Allocation failed/i.test(result.stderr ?? '')) return false;

	throw new Error(`the capped run of ${path.basename(input)} failed for another reason: ${result.stderr}`);
}
