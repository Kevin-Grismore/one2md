/**
 * The size and structure ceilings, and the archive facts a caller needs to
 * predict whether a notebook will fit.
 *
 * These caps exist so a malformed or hostile archive cannot expand without
 * bound. They are only useful if a caller can move them, and if a breach says
 * which one was hit — a conversion that stops with "exceeds a safety limit"
 * and no further detail is not actionable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { convertFile, inspect } from '../src/convert-file';
import { MemorySink } from '../src/sinks';
import { listSections } from '../src/read-section';
import { DEFAULT_CABINET_LIMITS } from '../src/onenote-file/cabinet/cabinet';
import { DEFAULT_READER_OPTIONS } from '../src/onenote-file/onestore/options';
import { FIXTURES } from './helpers';

const PACKAGE = 'makecab-lzx-notebook.onepkg';

function fixture(name: string): Uint8Array {
	return new Uint8Array(nodeFs.readFileSync(nodePath.join(FIXTURES, name)));
}

test('a notebook lists the folder and expanded size of every section', () => {
	// Both come from the archive index, so listing stays free of decompression.
	// The folder matters: a Cabinet folder is one continuous LZX stream, so
	// sections sharing one cannot be expanded independently.
	const sections = listSections(fixture(PACKAGE), PACKAGE);

	assert.ok(sections.length > 0);
	for (const section of sections) {
		assert.equal(typeof section.folderIndex, 'number');
		assert.ok((section.expandedLength ?? 0) > 0, 'a section reports its expanded size');
	}
});

test('a bare .one reports no folder, having no archive', () => {
	const [section] = listSections(fixture('testOneNote2016.one'), 'testOneNote2016.one');

	assert.equal(section.folderIndex, undefined);
	assert.equal(section.expandedLength, undefined);
});

test('listing honours the entry cap, and can be lifted past it', () => {
	const data = fixture(PACKAGE);

	// Listing parses the archive header, which enforces the per-entry cap — so a
	// notebook with an oversized section cannot even be listed at the default.
	assert.throws(
		() => inspect(data, PACKAGE, { ...DEFAULT_CABINET_LIMITS, maxEntryBytes: 1024 }),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_CAB_ENTRY_LIMIT');

	assert.ok(inspect(data, PACKAGE, { ...DEFAULT_CABINET_LIMITS, maxEntryBytes: 1024 * 1024 }).length > 0);
});

test('a cap breach is reported against the file, not thrown away', async () => {
	const sink = new MemorySink();
	const report = await convertFile(fixture(PACKAGE), PACKAGE, sink, {
		limits: { ...DEFAULT_CABINET_LIMITS, maxEntryBytes: 1024 },
	});

	assert.equal(sink.files.size, 0);
	assert.deepEqual(report.errors.map(error => [error.kind, error.code]),
		[['limit', 'ONENOTE_CAB_ENTRY_LIMIT']]);
});

test('reader ceilings reach the section reader too', async () => {
	// Not just the archive: the per-section structural limits must be reachable,
	// because the object limit is what bounds heap, and its default admits far
	// more than a small machine can hold.
	const sink = new MemorySink();
	const report = await convertFile(fixture('testOneNote.one'), 'testOneNote.one', sink, {
		readerOptions: { ...DEFAULT_READER_OPTIONS, maxObjects: 1 },
	});

	assert.equal(report.notes.length, 0);
	assert.equal(report.errors.length, 1);
	assert.equal(report.errors[0].code, 'ONENOTE_OBJECT_LIMIT');
});

test('the defaults are unchanged when nothing is passed', async () => {
	// The caps are a safety property; raising them should take saying so.
	assert.equal(DEFAULT_CABINET_LIMITS.maxEntryBytes, 512 * 1024 * 1024);
	assert.equal(DEFAULT_CABINET_LIMITS.maxExpandedBytes, 2 * 1024 * 1024 * 1024);

	const sink = new MemorySink();
	const report = await convertFile(fixture(PACKAGE), PACKAGE, sink);

	assert.deepEqual(report.errors, []);
	assert.ok(report.notes.length > 0);
});

test('a loose section can be told which notebook it came from', async () => {
	// Extracting a .onepkg before converting is the route for a notebook too
	// large to expand in memory, but the sections arrive as loose files with the
	// notebook's name lost. Naming it restores both the folder and the front
	// matter, so the cheaper route costs nothing in fidelity.
	const withName = new MemorySink();
	const without = new MemorySink();

	await convertFile(fixture('testOneNote2016.one'), 'testOneNote2016.one', withName, { notebookName: 'Archive' });
	await convertFile(fixture('testOneNote2016.one'), 'testOneNote2016.one', without);

	const [named] = [...withName.files.keys()];
	const [bare] = [...without.files.keys()];

	assert.ok(named.startsWith('Archive/'), `expected a notebook folder, got ${named}`);
	assert.ok(!bare.startsWith('Archive/'));

	const text = new TextDecoder().decode(withName.files.get(named));
	assert.match(text, /^notebook: "Archive"$/m);
});
