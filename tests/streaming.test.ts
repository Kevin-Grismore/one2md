/**
 * The bounded pipeline against the one it replaces.
 *
 * There is only one thing worth asserting about a rewrite whose purpose is to
 * use less memory: that it produces exactly what the original produced. So the
 * check is the fixtures, converted both ways, compared byte for byte — the same
 * paths, the same note text, the same attachment bytes. Anything the streaming
 * path gets subtly wrong about whitespace, escaping or ordering shows up as a
 * differing file rather than as a plausible-looking note.
 *
 * The second thing these check is the claim that makes it worth doing: that
 * what the conversion holds resident does not follow the size of the input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

import { convertFile } from '../src/convert-file';
import { FsSink, MemorySink } from '../src/sinks';
import { convertFileStream, convertSectionStream } from '../src/stream/convert';
import { StreamWorkspace } from '../src/stream/workspace';
import { FileDescriptorByteSource, Uint8ArrayByteSource } from '../src/storage/byte-source';
import { StreamSection } from '../src/stream/section';
import { AssetWriter } from '../src/stream/assets';
import { asChunkedSink } from '../src/stream/sink';
import { NullSink } from '../src/sinks';
import { diffTrees, fixtures } from './helpers';

function read(path: string): Uint8Array {
	return new Uint8Array(nodeFs.readFileSync(path));
}

function tree(sink: MemorySink): Map<string, Buffer> {
	return new Map([...sink.files].map(([path, data]) => [path, Buffer.from(data)] as const));
}

for (const fixture of fixtures(['.one', '.onepkg'])) {
	test(`the streaming pipeline matches the eager one for ${fixture.name}`, async () => {
		const data = read(fixture.path);

		const eager = new MemorySink();
		const eagerReport = await convertFile(data, fixture.name, eager);
		assert.deepEqual(eagerReport.errors, [], `${fixture.name} reported errors on the eager path`);

		const streamed = new MemorySink();
		const workspace = new StreamWorkspace();
		try {
			const summary = await convertFileStream(data, fixture.name, streamed, { workspace });
			assert.deepEqual([...workspace.failures()], [],
				`${fixture.name} reported errors on the streaming path`);
			assert.equal(summary.noteCount, eagerReport.notes.length, 'note counts differ');
			assert.equal(summary.attachmentCount, eagerReport.attachments.length,
				'attachment counts differ');
		}
		finally {
			workspace.close();
		}

		assert.deepEqual(diffTrees(tree(streamed), tree(eager)), [],
			`${fixture.name} converts differently through the streaming pipeline`);
	});
}

test('a loose section converts identically straight from a file descriptor', async () => {
	// The descriptor path is the one that never holds the section, so it is
	// worth checking separately from the in-memory one.
	for (const fixture of fixtures(['.one'])) {
		const eager = new MemorySink();
		await convertFile(read(fixture.path), fixture.name, eager);

		const streamed = new MemorySink();
		const fd = nodeFs.openSync(fixture.path, 'r');
		const workspace = new StreamWorkspace();

		try {
			await convertSectionStream(
				new FileDescriptorByteSource(fd), fixture.name, streamed, { workspace });
			assert.deepEqual([...workspace.failures()], [], `${fixture.name} failed from a descriptor`);
		}
		finally {
			workspace.close();
			nodeFs.closeSync(fd);
		}

		assert.deepEqual(diffTrees(tree(streamed), tree(eager)), [],
			`${fixture.name} differs when read through a descriptor`);
	}
});

test('the skip reports agree, item for item', async () => {
	for (const fixture of fixtures(['.one', '.onepkg'])) {
		const data = read(fixture.path);

		const eager = await convertFile(data, fixture.name, new MemorySink());
		const workspace = new StreamWorkspace();

		try {
			await convertFileStream(data, fixture.name, new MemorySink(), { workspace });
			assert.deepEqual(
				[...workspace.skips()],
				eager.skipped,
				`${fixture.name} skipped different items`);
		}
		finally {
			workspace.close();
		}
	}
});

test('deleted pages and attachment suppression behave as they do on the eager path', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'testOneNote.one');
	assert.ok(fixture, 'testOneNote.one fixture is missing');
	const data = read(fixture.path);

	for (const options of [{ includeDeleted: true }, { writeAttachments: false }, { frontmatter: false },
		{ nestSubpages: false }, { attachmentsDir: '' }]) {
		const eager = new MemorySink();
		await convertFile(data, fixture.name, eager, options);

		const streamed = new MemorySink();
		const workspace = new StreamWorkspace();
		try {
			await convertFileStream(data, fixture.name, streamed, { ...options, workspace });
		}
		finally {
			workspace.close();
		}

		assert.deepEqual(diffTrees(tree(streamed), tree(eager)), [],
			`${JSON.stringify(options)} converts differently`);
	}
});

test('a batch shares names across files, as the eager workspace does', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'testOneNote2016.one');
	assert.ok(fixture, 'testOneNote2016.one fixture is missing');
	const data = read(fixture.path);

	const sink = new MemorySink();
	const workspace = new StreamWorkspace();

	try {
		const first = await convertFileStream(data, 'a.one', sink, { workspace });
		const second = await convertFileStream(data, 'b.one', sink, { workspace });

		assert.ok(second.noteCount > first.noteCount, 'the second conversion wrote no notes');
		assert.equal(sink.files.size, new Set(sink.files.keys()).size, 'a path was written twice');
	}
	finally {
		workspace.close();
	}
});

/**
 * What the pipeline holds while it works.
 *
 * The budget is a ceiling on the descriptor page cache and the read window, and
 * this checks that it is one: a section is converted with a small budget and
 * the resident total is measured after every page. A conversion that quietly
 * materialized a section would not stay under a budget a fraction of its size.
 */
test('resident bytes stay inside the configured budget, whatever the section', async () => {
	const cacheBytes = 512 * 1024;
	const windowBytes = 128 * 1024;
	const ceiling = (cacheBytes + windowBytes) * 2;

	for (const fixture of fixtures(['.one'])) {
		const workspace = new StreamWorkspace();
		const sink = asChunkedSink(new NullSink());
		const assets = new AssetWriter(sink, workspace, { writeAttachments: true });

		const section = StreamSection.open(
			new Uint8ArrayByteSource(read(fixture.path)),
			assets,
			{ cacheBytes, conversionCacheBytes: cacheBytes, windowBytes });

		try {
			let peak = 0;

			for (const page of section.pages()) {
				const writer = await sink.open(`${page.title || 'untitled'}.md`);
				const note = section.openNote(writer);

				await page.render(note, {
					attachmentsDir: 'attachments',
					linkPrefix: 'attachments',
					noteName: page.title || 'untitled',
				});
				await note.finish();
				await writer.close();

				peak = Math.max(peak, section.stats.residentBytes);
			}

			assert.ok(peak <= ceiling,
				`${fixture.name} held ${peak} bytes resident against a ${ceiling}-byte ceiling`);
		}
		finally {
			section.close();
			workspace.close();
		}
	}
});

/**
 * The claim, stated as something that can fail.
 *
 * The budget here is smaller than the section, so a conversion that needed the
 * section resident could not finish under it — and the output still has to be
 * the same bytes. That is the whole thesis in one assertion: what the pipeline
 * holds is what it was told it may hold, not what it was given to read.
 */
test('a section converts identically under a budget smaller than itself', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'handwriting_recognition.one');
	assert.ok(fixture, 'handwriting_recognition.one fixture is missing');

	const data = read(fixture.path);
	const eager = new MemorySink();
	await convertFile(data, fixture.name, eager);

	const streamed = new MemorySink();
	const workspace = new StreamWorkspace();

	try {
		await convertFileStream(data, fixture.name, streamed, {
			workspace,
			storage: {
				pageSize: 16 * 1024,
				cacheBytes: 32 * 1024,
				conversionCacheBytes: 32 * 1024,
				windowBytes: 64 * 1024,
			},
		});
		assert.deepEqual([...workspace.failures()], [], 'the conversion failed under a small budget');
	}
	finally {
		workspace.close();
	}

	assert.deepEqual(diffTrees(tree(streamed), tree(eager)), [],
		'a small budget changes what is written');
});

test('an open FsSink file is written in place, and an abandoned one is removed', async () => {
	const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-sink-'));

	try {
		const sink = new FsSink(root, false);

		const writer = await sink.open('notes/page.md');
		await writer.write(new TextEncoder().encode('first '));
		await writer.write(new TextEncoder().encode('second'));
		await writer.close();

		assert.equal(nodeFs.readFileSync(nodePath.join(root, 'notes', 'page.md'), 'utf8'), 'first second');

		const abandoned = await sink.open('notes/partial.md');
		await abandoned.write(new TextEncoder().encode('half a file'));
		await abandoned.abort!();

		assert.equal(nodeFs.existsSync(nodePath.join(root, 'notes', 'partial.md')), false,
			'an abandoned file was left behind');
	}
	finally {
		nodeFs.rmSync(root, { recursive: true, force: true });
	}
});

test('a legacy Sink still works, through the buffering adapter', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'testOneNote.one');
	assert.ok(fixture, 'testOneNote.one fixture is missing');

	// A sink with only `write`: what the Obsidian plugin supplies.
	const written = new Map<string, Uint8Array>();
	const legacy = { write: async (path: string, data: Uint8Array) => void written.set(path, data) };

	const workspace = new StreamWorkspace();
	try {
		await convertFileStream(read(fixture.path), fixture.name, legacy, { workspace });
	}
	finally {
		workspace.close();
	}

	const eager = new MemorySink();
	await convertFile(read(fixture.path), fixture.name, eager);

	assert.deepEqual(
		diffTrees(
			new Map([...written].map(([path, data]) => [path, Buffer.from(data)] as const)),
			tree(eager)),
		[],
		'a legacy sink receives different bytes');
});
