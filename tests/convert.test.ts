/**
 * The end-to-end gate: every fixture, through the real pipeline, compared file
 * by file against a recorded tree.
 *
 * This is what catches a regression in the vendored parser after an upstream
 * re-sync, and a regression in this repository's own naming and layout rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';

import { convertFile, Workspace } from '../src/convert-file';
import { MemorySink } from '../src/sinks';
import { expectedFor, expectFiles, fixtures } from './helpers';

function read(path: string): Uint8Array {
	return new Uint8Array(nodeFs.readFileSync(path));
}

/**
 * Sections packaged the way OneNote's sync protocol writes them, rather than
 * the desktop MS-ONESTORE encoding. The reader declines these deliberately, so
 * the contract worth pinning is the error, not a conversion.
 */
const NOT_REVISION_STORE = /^testOneNoteFromOffice365/;

for (const fixture of fixtures(['.one', '.onepkg'])) {
	if (NOT_REVISION_STORE.test(fixture.name)) {
		test(`${fixture.name} is declined as an encoding the reader does not implement`, async () => {
			const sink = new MemorySink();
			const report = await convertFile(read(fixture.path), fixture.name, sink);

			assert.equal(sink.files.size, 0, 'nothing should be written for a file that cannot be read');
			assert.deepEqual(report.errors.map(error => [error.kind, error.code]),
				[['unsupported', 'ONENOTE_NOT_REVISION_STORE']]);
		});
		continue;
	}

	test(`converts ${fixture.name}`, async () => {
		const sink = new MemorySink();
		const report = await convertFile(read(fixture.path), fixture.name, sink);

		assert.deepEqual(report.errors, [], `${fixture.name} reported errors`);
		expectFiles(sink.files, expectedFor(fixture), fixture.name);
	});
}

test('deleted pages are left out unless asked for', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'testOneNote.one');
	assert.ok(fixture, 'testOneNote.one fixture is missing');

	const without = new MemorySink();
	const withThem = new MemorySink();

	await convertFile(read(fixture.path), fixture.name, without);
	await convertFile(read(fixture.path), fixture.name, withThem, { includeDeleted: true });

	assert.ok(withThem.files.size >= without.files.size,
		'including deleted pages should never produce fewer files');
});

test('--no-attachments writes notes but no assets', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'handwriting_recognition.one');
	assert.ok(fixture, 'handwriting_recognition.one fixture is missing');

	const sink = new MemorySink();
	const report = await convertFile(read(fixture.path), fixture.name, sink, { writeAttachments: false });

	assert.equal(report.attachments.length, 0);
	assert.ok(report.notes.length > 0, 'notes should still be written');
	assert.deepEqual([...sink.files.keys()].filter(path => !path.endsWith('.md')), []);
});

test('the same bytes are written once and linked twice', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'testOneNote.one');
	assert.ok(fixture, 'testOneNote.one fixture is missing');

	const sink = new MemorySink();
	const report = await convertFile(read(fixture.path), fixture.name, sink);
	const digests = new Set([...sink.files.values()].map(data => Buffer.from(data).toString('base64')));

	assert.equal(digests.size, sink.files.size, 'two output files hold identical bytes');
	assert.equal(new Set(report.attachments).size, report.attachments.length, 'an attachment path repeats');
});

test('a batch shares its names, so same-named sections do not collide', async () => {
	const fixture = fixtures(['.one']).find(entry => entry.name === 'testOneNote2016.one');
	assert.ok(fixture, 'testOneNote2016.one fixture is missing');

	const data = read(fixture.path);
	const shared = new Workspace();
	const sink = new MemorySink();

	// The same input twice stands in for two notebooks that share a section name.
	await convertFile(data, fixture.name, sink, { workspace: shared });
	await convertFile(data, fixture.name, sink, { workspace: shared });

	assert.equal(sink.files.size, 2, 'the second conversion overwrote the first');
	assert.deepEqual([...sink.files.keys()].sort(), [
		'testOneNote2016 1/So good.md',
		'testOneNote2016/So good.md',
	]);
});
