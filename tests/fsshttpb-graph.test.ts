/**
 * The adapter, and the fork in the road above it.
 *
 * The end-to-end proof is in `tests/expected/`, where both packaged fixtures now
 * record real markdown. These tests pin the properties that make that work, so a
 * regression says which half broke rather than only that the output moved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { buildObjectGraph } from '../src/fsshttpb/object-graph';
import { readSection } from '../src/read-section';
import { readFileHeader } from '../src/onenote-file/onestore/file-header';
import { DEFAULT_READER_OPTIONS } from '../src/onenote-file/onestore/options';
import { Jcid } from '../src/onenote-file/semantic/schema';
import { FIXTURES } from './helpers';

const PACKAGED = ['testOneNoteFromOffice365.one', 'testOneNoteFromOffice365-2.one'];
const DESKTOP = ['testOneNote2016.one', 'handwriting_recognition.one', 'testOneNote.one'];

function fixture(name: string): Uint8Array {
	return new Uint8Array(nodeFs.readFileSync(nodePath.join(FIXTURES, name)));
}

for (const name of PACKAGED) {
	test(`${name} builds an object graph the semantic layer can use`, () => {
		const graph = buildObjectGraph(fixture(name));

		assert.ok(graph.revisions.length > 0);
		assert.ok(graph.objects.length > 0);

		// Every revision must land in an object space, or the materializer has
		// nothing to select, and every object must belong to a revision.
		for (const revision of graph.revisions) {
			assert.ok(revision.objectSpaceId, 'a revision without an object space');
		}
		for (const object of graph.objects) {
			assert.ok(object.revisionId, 'an object not attached to a revision');
		}

		// Exactly one revision per cell is current. More than one would make the
		// choice of which to materialize arbitrary.
		const current = graph.revisions.filter(revision => revision.roleAssociations.length > 0);
		assert.ok(current.length > 0, 'no revision is current');
		for (const revision of current) {
			assert.deepEqual(revision.roleAssociations.map(association => association.role), [1]);
		}
	});

	test(`${name} decodes every property set through the rebuilt ID table`, () => {
		const graph = buildObjectGraph(fixture(name));
		const withData = graph.objects.filter(object => object.propertySet);

		// The CompactID table is rebuilt per object from its own reference
		// arrays. If that were wrong, decoding would fail rather than degrade —
		// so decoding all of them is the check.
		assert.equal(withData.length, graph.objects.length,
			'an object carried data that did not decode');
		assert.ok(withData.length > 100);
	});

	test(`${name} yields pages with titles and content`, () => {
		const section = readSection(fixture(name));

		assert.ok(section.pages.length > 0, 'no pages');
		for (const page of section.pages) {
			assert.ok(page.title.length > 0, 'a page without a title');
			assert.ok(page.id.length > 0, 'a page without a stable identity');
			assert.ok(page.outlines.length + page.directContent.length > 0,
				`page "${page.title}" has no content`);
		}
	});

	test(`${name} reaches the object types a page is made of`, () => {
		const graph = buildObjectGraph(fixture(name));
		const seen = new Set(graph.objects.map(object => object.jcid));

		for (const [label, jcid] of [
			['page', Jcid.pageNode],
			['outline', Jcid.outlineNode],
			['rich text', Jcid.richTextNode],
		] as [string, number][]) {
			assert.ok(seen.has(jcid), `expected a ${label} object`);
		}
	});
}

test('the reader is chosen from the file header, not the file name', () => {
	for (const name of PACKAGED) {
		const data = fixture(name);
		assert.equal(readFileHeader(data, data.length, DEFAULT_READER_OPTIONS).storageFormat,
			'file-synchronization-package');
		assert.ok(readSection(data).pages.length > 0);
	}

	for (const name of DESKTOP) {
		const data = fixture(name);
		assert.equal(readFileHeader(data, data.length, DEFAULT_READER_OPTIONS).storageFormat,
			'revision-store');
		assert.ok(readSection(data).pages.length > 0);
	}
});

test('both encodings produce the same shape of section', () => {
	// A packaged section and a desktop one are different files on disk and the
	// same thing afterwards. Nothing above the storage layer should be able to
	// tell them apart.
	const packaged = readSection(fixture('testOneNoteFromOffice365.one'));
	const desktop = readSection(fixture('testOneNote2016.one'));

	for (const section of [packaged, desktop]) {
		assert.equal(typeof section.name, 'string');
		assert.ok(Array.isArray(section.pages));
		for (const page of section.pages) {
			assert.equal(typeof page.title, 'string');
			assert.equal(typeof page.level, 'number');
			assert.equal(typeof page.isDeleted, 'boolean');
			assert.equal(typeof page.isConflictPage, 'boolean');
		}
	}
});

test('a packaged section carries its attachments through the file-data path', () => {
	// The path this exercises was written but never executed until this fixture
	// existed, and it held two defects: the object-data BLOB element type, and
	// the packaged form of a file-data reference. Neither published web export
	// embeds a file, so nothing else can catch a regression here.
	const graph = buildObjectGraph(fixture('packagedWithAttachments.one'));

	assert.equal(graph.fileDataObjects.length, 2, 'both payloads reached the graph');

	const sizes = graph.fileDataObjects.map(item => item.payload.length).sort((a, b) => a - b);
	assert.deepEqual(sizes, [70, 80], 'a 1x1 PNG and a small text file');

	for (const item of graph.fileDataObjects) {
		assert.match(item.referenceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			'a packaged file-data reference normalizes to a bare GUID');
	}

	// The reference must round-trip through the vendored resolver's format.
	const referenced = graph.objects.filter(object => object.fileDataReference);
	assert.equal(referenced.length, 2);
	for (const object of referenced) {
		assert.match(object.fileDataReference!, /^<ifndf>\{[0-9a-f-]{36}\}$/);
	}
});
