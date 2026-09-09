/**
 * Memory claims, checked by a process that is not allowed to exceed them.
 *
 * Everything else that checks memory here checks the converter's own
 * accounting: the components report what they held, the total is compared
 * against the budget, and the comparison passes. That is worth having — it is
 * how a regression in a component's own bookkeeping is caught — but it is
 * circular. An allocation nobody thought to account for is invisible to it,
 * which is exactly the kind of allocation that was found in the ink decoder.
 *
 * So these run the real code in a real child process under `V8`'s own heap
 * limit, on input constructed to be far larger than that limit. Nothing is
 * measured and nothing is trusted: either the work finishes inside the cap or
 * the process dies, and the test is which of those happened.
 *
 * Each case also runs the version being replaced under the same cap, and
 * requires it to die. Without that, a cap set too generously would pass
 * everything and prove nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
const TSX = nodePath.join(ROOT, 'node_modules', '.bin', 'tsx');

/**
 * The cap every case below runs under.
 *
 * Node's own floor is a few megabytes and `tsx` compiling the sources takes a
 * good deal more, so this cannot go much lower without failing for reasons
 * that have nothing to do with the converter. What matters is that it is far
 * under what the arrays being replaced would need, which the paired
 * `oracle` runs confirm rather than assume.
 */
const HEAP_CAP_MB = 40;

/**
 * How the cap is applied.
 *
 * Through the environment rather than on the command line, because `tsx`
 * launches a child of its own to do the compiling and that child inherits the
 * environment but not the parent's V8 flags. Passing `--max-old-space-size`
 * to the wrapper caps the wrapper, which does nothing at all — and looks
 * exactly like a cap that is being honoured.
 */
const capped = {
	cwd: ROOT,
	encoding: 'utf8' as const,
	env: {
		...process.env,
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=${HEAP_CAP_MB}`.trim(),
	},
};

interface Outcome {
	ok: boolean;
	output: string;
}

/** Run a snippet in a child with an enforced heap limit. */
function underCap(source: string): Outcome {
	const script = nodePath.join(
		nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-cap-')),
		'case.ts');

	nodeFs.writeFileSync(script, source);

	try {
		const result = spawnSync(TSX, [script], { ...capped, timeout: 180_000 });

		return {
			ok: result.status === 0,
			output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
		};
	}
	finally {
		nodeFs.rmSync(nodePath.dirname(script), { recursive: true, force: true });
	}
}

/**
 * A source preamble that builds a large ink path on disk.
 *
 * Written to a file rather than held, because the point is a heap cap and a
 * test that filled the heap before reaching the code under test would be
 * measuring itself.
 */
const BUILD_PATH = `
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import nodePath from 'node:path';

/**
 * Six million coordinates.
 *
 * As arrays that is the decoded vector at forty-eight megabytes plus the two
 * axes at twenty-four each — comfortably past the cap, which the paired oracle
 * run below confirms by dying. As a file it is six megabytes of one-byte
 * deltas, and as a spool it is thirty-two megabytes on disk.
 */
const VALUES = 6_000_000;

function buildPath(): string {
	const file = nodePath.join(
		nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-inkcase-')), 'path.bin');
	const out = nodeFs.openSync(file, 'w');

	// One chunk at a time, so building the input is itself bounded.
	const chunk = new Uint8Array(64 * 1024);
	let at = 0;

	const push = (byte: number) => {
		chunk[at++] = byte;
		if (at === chunk.length) {
			nodeFs.writeSync(out, chunk, 0, at);
			at = 0;
		}
	};

	const varint = (value: number) => {
		let rest = value;
		for (;;) {
			const seven = rest % 128;
			rest = Math.floor(rest / 128);
			push(rest > 0 ? seven | 0x80 : seven);
			if (rest === 0) return;
		}
	};

	varint(VALUES * 2);
	// Deltas small enough to be one byte each, so the file is about three
	// megabytes and the arrays it would decode into are twenty-four.
	for (let index = 0; index < VALUES; index++) varint((index % 37) * 2);

	if (at > 0) nodeFs.writeSync(out, chunk, 0, at);
	nodeFs.closeSync(out);
	return file;
}
`;

test('a three-million-point ink path decodes inside a hard heap cap', () => {
	const streamed = underCap(`${BUILD_PATH}
import { RangeReader } from '${ROOT}/src/resolve/range-reader.ts';
import { FileDescriptorByteSource } from '${ROOT}/src/storage/byte-source.ts';
import { ByteWindow } from '${ROOT}/src/storage/byte-window.ts';
import { PagedKeyValueStore } from '${ROOT}/src/storage/paged-key-value-store.ts';
import { ByteSpool } from '${ROOT}/src/storage/spool.ts';
import { decodeInkPath } from '${ROOT}/src/stream/ink.ts';

const file = buildPath();
const fd = nodeFs.openSync(file, 'r');
const store = new PagedKeyValueStore({ pageSize: 16 * 1024, cacheBytes: 256 * 1024, bucketCount: 1024 });

try {
	const source = new FileDescriptorByteSource(fd, nodeFs.fstatSync(fd).size);
	const window = new ByteWindow(source, 64 * 1024);
	const spool = new ByteSpool(store, 1, 0, 4096);

	let points = 0;
	let checksum = 0;

	const drawn = decodeInkPath(
		new RangeReader(window, { offset: 0, length: source.size }),
		8192, spool, 2, 0, 1, Infinity,
		(x, y) => { points++; checksum = (checksum + x + y) % 1_000_003; });

	if (!drawn) throw new Error('nothing was drawn');
	if (points !== VALUES / 2) throw new Error(\`\${points} points, expected \${VALUES / 2}\`);

	process.stdout.write(\`points=\${points} checksum=\${checksum}\\n\`);
}
finally {
	store.close();
	nodeFs.closeSync(fd);
	nodeFs.rmSync(nodePath.dirname(file), { recursive: true, force: true });
}
`);

	assert.ok(streamed.ok,
		`the streaming decoder should fit in ${HEAP_CAP_MB}M:\n${streamed.output}`);
	assert.match(streamed.output, /points=3000000/);

	// And the cap is binding: the arrays the decoder replaced cannot fit in it.
	// Without this the case above would pass with a cap of any size.
	const oracle = underCap(`${BUILD_PATH}
import { decodePacketValues, decodeSignedVector } from '${ROOT}/src/onenote-file/semantic/ink.ts';

const file = buildPath();
const bytes = new Uint8Array(nodeFs.readFileSync(file));
const encoded = decodeSignedVector(bytes, Infinity);
const xs = decodePacketValues(encoded, 0, VALUES / 2);
const ys = decodePacketValues(encoded, VALUES / 2, VALUES / 2);
process.stdout.write(\`points=\${xs.length + ys.length}\\n\`);
`);

	assert.equal(oracle.ok, false,
		`the array decoder was expected to exhaust a ${HEAP_CAP_MB}M heap, but it did not — `
		+ `the cap is too generous to prove anything:\n${oracle.output}`);
	assert.match(oracle.output, /heap|memory|Allocation failed/i,
		`the array decoder failed for some reason other than memory:\n${oracle.output}`);
});

test('a section converts through the CLI inside a hard heap cap', () => {
	const out = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-cap-out-'));
	const scratch = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-cap-temp-'));

	try {
		// The whole command, not a component: descriptors, index, resolver,
		// renderer, sink and report, all under a limit the runtime enforces.
		const result = spawnSync(
			TSX,
			[
				nodePath.join(ROOT, 'src/cli.ts'),
				nodePath.join(ROOT, 'tests/fixtures/handwriting_recognition.one'),
				'-o', out,
				'--memory-budget', '2M',
				'--temp-dir', scratch,
				'-q',
			],
			{ ...capped, timeout: 180_000 });

		assert.equal(result.status, 0,
			`the bounded CLI should run inside ${HEAP_CAP_MB}M:\n${result.stdout}${result.stderr}`);

		const written = nodeFs.readdirSync(out, { recursive: true })
			.map(String).filter(name => name.endsWith('.md'));
		assert.ok(written.length > 0, 'the run produced no notes, so it converted nothing');

		assert.deepEqual(
			nodeFs.readdirSync(scratch).filter(name => name.startsWith('one2md-')), [],
			'the temporary stores should be gone');
	}
	finally {
		for (const path of [out, scratch]) nodeFs.rmSync(path, { recursive: true, force: true });
	}
});
