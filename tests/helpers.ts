/**
 * Fixture-driven comparison, after obsidian-importer's `tests/helpers.ts`.
 *
 * Each input has an expected/ tree beside it holding what the conversion should
 * produce — real markdown, real attachments, the files you would end up with.
 * Adding a fixture is: drop the input in, run the tests, review what appears.
 * Changing one on purpose is: run with UPDATE_EXPECTED=1 and read the diff.
 */
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = fileURLToPath(new URL('.', import.meta.url));
export const FIXTURES = nodePath.join(HERE, 'fixtures');
export const EXPECTED = nodePath.join(HERE, 'expected');

export interface Fixture {
	/** File name, including the extension. */
	name: string;
	/** Full path to the input. */
	path: string;
	/** Whether it came from the uncommitted local/ directory. */
	local: boolean;
}

/**
 * Inputs to convert: the ones committed here, plus anything in tests/local/.
 *
 * local/ is gitignored, and exists for a file that cannot be committed — your
 * own export, most of the time. Drop one in, run the tests, and its conversion
 * is recorded in local/expected/ for you to read. Nothing about it leaves the
 * machine.
 */
export function fixtures(extensions: string[]): Fixture[] {
	const found: Fixture[] = [];

	for (const [dir, local] of [[FIXTURES, false], [nodePath.join(HERE, 'local'), true]] as [string, boolean][]) {
		if (!nodeFs.existsSync(dir)) continue;

		for (const name of nodeFs.readdirSync(dir).sort((a, b) => a.localeCompare(b))) {
			if (!extensions.some(extension => name.endsWith(extension))) continue;
			found.push({ name, path: nodePath.join(dir, name), local });
		}
	}

	return found;
}

/** Where a fixture's recording belongs; a local one records inside local/. */
export function expectedFor(fixture: Fixture): string {
	return fixture.local
		? nodePath.join(nodePath.dirname(fixture.path), 'expected', fixture.name)
		: nodePath.join(EXPECTED, fixture.name);
}

/** Every file under a directory, by path relative to it, in path order. */
export function readTree(dir: string): Map<string, Buffer> {
	const files = new Map<string, Buffer>();

	const walk = (current: string) => {
		for (const entry of nodeFs.readdirSync(current, { withFileTypes: true })) {
			const full = nodePath.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else files.set(nodePath.relative(dir, full).split(nodePath.sep).join('/'), nodeFs.readFileSync(full));
		}
	};
	walk(dir);

	return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/** Extensions worth showing in full when they differ. */
const TEXT = ['.md', '.txt', '.json', '.csv'];

export function diffTrees(actual: Map<string, Buffer>, expected: Map<string, Buffer>): string[] {
	const problems: string[] = [];

	for (const path of expected.keys()) {
		if (!actual.has(path)) problems.push(`missing: ${path}`);
	}
	for (const path of actual.keys()) {
		if (!expected.has(path)) problems.push(`unexpected: ${path}`);
	}

	for (const [path, actualBytes] of actual) {
		const expectedBytes = expected.get(path);
		if (!expectedBytes || actualBytes.equals(expectedBytes)) continue;

		if (TEXT.some(extension => path.endsWith(extension))) {
			problems.push(
				`differs: ${path}`,
				`  expected: ${JSON.stringify(expectedBytes.toString('utf8'))}`,
				`  actual:   ${JSON.stringify(actualBytes.toString('utf8'))}`,
			);
		}
		else {
			problems.push(`differs: ${path} (${expectedBytes.length} bytes expected, ${actualBytes.length} actual)`);
		}
	}

	return problems;
}

/**
 * Recording is opt-in, and always fails the run.
 *
 * A test that quietly records whatever it was given is not a test: whatever the
 * conversion happened to produce — right or wrong — becomes the contract, and
 * the run goes green. So a missing or differing recording is a failure, and
 * writing one takes UPDATE_EXPECTED=1 and still fails, to force a look at what
 * was written before it is committed.
 */
function record(write: () => void, expected: string, label: string, existed: boolean): never {
	const where = nodePath.relative(process.cwd(), expected);

	if (!process.env.UPDATE_EXPECTED) {
		assert.fail(existed
			? `Output for ${label} differs from ${where}. If the change is intended, re-run with UPDATE_EXPECTED=1 and read the diff before committing.`
			: `No recorded output for ${label}. Re-run with UPDATE_EXPECTED=1 to record it at ${where}, then read what it wrote before committing.`);
	}

	nodeFs.rmSync(expected, { recursive: true, force: true });
	nodeFs.mkdirSync(nodePath.dirname(expected), { recursive: true });
	write();
	assert.fail(`Recorded ${where} for ${label}. Read it, then re-run without UPDATE_EXPECTED.`);
}

/** Compare a produced set of files against the recorded tree. */
export function expectFiles(produced: Map<string, Uint8Array>, expectedDir: string, label: string): void {
	const existed = nodeFs.existsSync(expectedDir);
	const actual = new Map([...produced].map(([path, data]) => [path, Buffer.from(data)] as const));
	const problems = existed ? diffTrees(actual, readTree(expectedDir)) : ['not recorded'];

	if (problems.length === 0) return;

	if (process.env.UPDATE_EXPECTED || !existed) {
		record(() => {
			for (const [path, data] of actual) {
				const full = nodePath.join(expectedDir, ...path.split('/'));
				nodeFs.mkdirSync(nodePath.dirname(full), { recursive: true });
				nodeFs.writeFileSync(full, data);
			}
		}, expectedDir, label, existed);
	}

	assert.deepEqual(problems, [], `output differs from ${nodePath.relative(process.cwd(), expectedDir)}/\n${problems.join('\n')}`);
}
