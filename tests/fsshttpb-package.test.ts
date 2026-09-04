/**
 * The data element package, checked for internal consistency.
 *
 * Every structure is read with an exact-length assertion, so simply parsing is
 * already meaningful. These tests go further and check the things the format
 * requires of itself: that the storage index accounts for every manifest and
 * revision, that each object declaration agrees with the data beside it, and
 * that the object type codes are ones OneNote actually uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { extendedGuidKey } from '../src/fsshttpb/binary';
import { readDataElementPackage } from '../src/fsshttpb/package';
import { Partition } from '../src/fsshttpb/types';
import { Jcid } from '../src/onenote-file/semantic/schema';
import { readFileHeader } from '../src/onenote-file/onestore/file-header';
import { DEFAULT_READER_OPTIONS } from '../src/onenote-file/onestore/options';
import { FIXTURES } from './helpers';

const PACKAGED = ['testOneNoteFromOffice365.one', 'testOneNoteFromOffice365-2.one'];

function fixture(name: string): Uint8Array {
	return new Uint8Array(nodeFs.readFileSync(nodePath.join(FIXTURES, name)));
}

function jcidOf(data: Uint8Array): number {
	return (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
}

for (const name of PACKAGED) {
	test(`${name} parses as a complete data element package`, () => {
		const parsed = readDataElementPackage(fixture(name));

		assert.equal(parsed.storageIndex.manifestMappings.length, 1);
		assert.ok(parsed.storageManifest.roots.length > 0);
		assert.ok(parsed.objectGroups.size > 0);
	});

	test(`${name} declares the cell schema its file header reports`, () => {
		const data = fixture(name);
		const header = readFileHeader(data, data.length, DEFAULT_READER_OPTIONS);

		assert.equal(readDataElementPackage(data).storageManifest.schema, header.cellSchemaId);
	});

	test(`${name} indexes every manifest and revision it holds`, () => {
		const parsed = readDataElementPackage(fixture(name));

		// The storage index is the file's own table of contents. If it and the
		// element list disagree, one of the two was read wrong.
		assert.equal(parsed.storageIndex.cellMappings.length, parsed.cellManifests.size);
		assert.equal(parsed.storageIndex.revisionMappings.length, parsed.revisionManifests.size);

		for (const mapping of parsed.storageIndex.cellMappings) {
			assert.ok(parsed.cellManifests.has(extendedGuidKey(mapping.id)),
				'a cell mapping names a manifest that is not in the package');
		}
		for (const mapping of parsed.storageIndex.revisionMappings) {
			assert.ok(parsed.revisionManifests.has(extendedGuidKey(mapping.id)),
				'a revision mapping names a manifest that is not in the package');
		}
	});

	test(`${name} links cells to revisions to object groups`, () => {
		const parsed = readDataElementPackage(fixture(name));
		const revisionByRevisionId = new Map(
			parsed.storageIndex.revisionMappings.map(mapping => [extendedGuidKey(mapping.revision), mapping.id]));

		let followed = 0;
		for (const cell of parsed.cellManifests.values()) {
			const mapped = revisionByRevisionId.get(extendedGuidKey(cell.currentRevision));
			assert.ok(mapped, 'a cell names a current revision the storage index does not map');

			const revision = parsed.revisionManifests.get(extendedGuidKey(mapped));
			assert.ok(revision, 'the mapped revision manifest is missing');

			for (const groupId of revision.objectGroups) {
				assert.ok(parsed.objectGroups.has(extendedGuidKey(groupId)),
					'a revision names an object group that is not in the package');
				followed++;
			}
		}

		assert.ok(followed > 0, 'no cell reached an object group');
	});

	test(`${name} has every object declaration agree with its data`, () => {
		const parsed = readDataElementPackage(fixture(name));
		let checked = 0;

		for (const group of parsed.objectGroups.values()) {
			assert.equal(group.declarations.length, group.data.length,
				'declarations and data pair up by position');

			for (let index = 0; index < group.declarations.length; index++) {
				const declaration = group.declarations[index];
				const data = group.data[index];

				// Three independent numbers written twice in the file. They agree
				// only if both structures were read correctly.
				assert.equal(declaration.objectReferenceCount, data.objectReferences.length);
				assert.equal(declaration.cellReferenceCount, data.cellReferences.length);
				if (declaration.dataSize !== undefined) assert.equal(declaration.dataSize, data.data?.length);
				checked++;
			}
		}

		assert.ok(checked > 100, `expected many objects, checked ${checked}`);
	});

	test(`${name} splits objects into a type code and a property set`, () => {
		const parsed = readDataElementPackage(fixture(name));
		const counts = new Map<number, number>();

		for (const group of parsed.objectGroups.values()) {
			for (let index = 0; index < group.declarations.length; index++) {
				const { partition } = group.declarations[index];
				counts.set(partition, (counts.get(partition) ?? 0) + 1);

				if (partition === Partition.ObjectMetadata) {
					assert.equal(group.data[index].data?.length, 4, 'object metadata is a four-byte JCID');
				}
			}
		}

		assert.ok((counts.get(Partition.ObjectData) ?? 0) > 0);
		assert.ok((counts.get(Partition.ObjectMetadata) ?? 0) > 0);
	});

	test(`${name} carries object types OneNote actually uses`, () => {
		const parsed = readDataElementPackage(fixture(name));
		const seen = new Set<number>();

		for (const group of parsed.objectGroups.values()) {
			for (let index = 0; index < group.declarations.length; index++) {
				if (group.declarations[index].partition !== Partition.ObjectMetadata) continue;
				const data = group.data[index].data;
				if (data) seen.add(jcidOf(data));
			}
		}

		// Structure alone could be right about framing and still be reading the
		// wrong bytes. Recognisable object types say the content is real.
		for (const [label, jcid] of [
			['page', Jcid.pageNode],
			['outline', Jcid.outlineNode],
			['outline element', Jcid.outlineElementNode],
			['rich text', Jcid.richTextNode],
			['page metadata', Jcid.pageMetadata],
		] as [string, number][]) {
			assert.ok(seen.has(jcid), `expected at least one ${label} object (0x${jcid.toString(16)})`);
		}
	});
}

test('the larger fixture holds the section objects the smaller one does not', () => {
	const parsed = readDataElementPackage(fixture('testOneNoteFromOffice365-2.one'));
	const seen = new Set<number>();

	for (const group of parsed.objectGroups.values()) {
		for (let index = 0; index < group.declarations.length; index++) {
			if (group.declarations[index].partition !== Partition.ObjectMetadata) continue;
			const data = group.data[index].data;
			if (data) seen.add(jcidOf(data));
		}
	}

	assert.ok(seen.has(Jcid.sectionNode), 'a section node');
	assert.ok(seen.has(Jcid.sectionMetadata), 'section metadata');
});
