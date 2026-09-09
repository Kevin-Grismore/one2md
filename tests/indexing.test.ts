/**
 * The index says what the readers say, without building what they build.
 *
 * An index is only worth having if it is not a second, quieter opinion about
 * the file. So every fixture is read both ways and the two are compared where
 * they can be: counts, identities, type codes, reference counts, revision
 * membership, and the actual bytes behind every range the index records.
 *
 * The lazy half is checked by using it. A range is worth nothing if what it
 * names cannot be decoded later, so a property set is read from the index —
 * bytes fetched on demand, CompactIDs resolved through the on-disk global
 * identification table — and compared with the one the eager reader decoded
 * during its own parse.
 *
 * The bound is checked by shrinking it. The same fixtures are indexed under a
 * budget far below their size, which must change nothing about the answers and
 * must keep resident bytes inside the budget — and the fixture that is twice
 * the size must not cost more than the smaller one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { extendedGuidKey } from '../src/fsshttpb/binary';
import { buildObjectGraph } from '../src/fsshttpb/object-graph';
import { ObjectData, ObjectDeclaration, ObjectGroup, readDataElementPackage } from '../src/fsshttpb/package';
import { PackageIndexedSection } from '../src/indexing/fsshttpb-index';
import { indexSection } from '../src/indexing/index-section';
import {
	IndexedGuid,
	IndexedSection,
	ObjectDescriptor,
	SectionIndex,
	SectionIndexOptions,
} from '../src/indexing/section-index';
import { readFileHeader } from '../src/onenote-file/onestore/file-header';
import { keyOf, RevisionStoreObject } from '../src/onenote-file/onestore/objects';
import { DEFAULT_READER_OPTIONS } from '../src/onenote-file/onestore/options';
import { readPropertySet } from '../src/onenote-file/onestore/property-set';
import { readRevisionStore } from '../src/onenote-file/onestore/revision-store';
import { Uint8ArrayByteSource } from '../src/storage/byte-source';
import { FIXTURES } from './helpers';

const DESKTOP = [
	'testOneNote.one',
	'testOneNote2016.one',
	'testOneNoteEmbeddedWordDoc.one',
	'handwriting_recognition.one',
];

const PACKAGED = [
	'testOneNoteFromOffice365.one',
	'testOneNoteFromOffice365-2.one',
	'packagedWithAttachments.one',
];

/**
 * A budget far below any fixture, so the cache must evict and the window must
 * slide. Small enough that a page holds only a handful of descriptors.
 */
const TIGHT: SectionIndexOptions = {
	pageSize: 2 * 1024,
	cacheBytes: 8 * 1024,
	bucketCount: 64,
	windowBytes: 1024,
};

function fixture(name: string): Uint8Array {
	return new Uint8Array(nodeFs.readFileSync(nodePath.join(FIXTURES, name)));
}

function open(name: string, options?: SectionIndexOptions): SectionIndex {
	return indexSection(new Uint8ArrayByteSource(fixture(name)), options);
}

function guid(id: IndexedGuid): string {
	return `${id.identifier}:${id.value}`;
}

/** What both readers know about an object without decoding anything. */
function identity(object: ObjectDescriptor): string[] {
	return [guid(object.id), String(object.jcid), String(object.referenceCount), String(object.isRevision)];
}

function storedIdentity(object: RevisionStoreObject): string[] {
	return [keyOf(object.id), String(object.jcid), String(object.referenceCount), String(object.isRevision)];
}

/**
 * The desktop encoding declares a file-data reference in the file node itself,
 * so the index carries it. The packaged encoding stores it as a property of the
 * object, which means reading a property set — and the index deliberately does
 * not, so it records the blob element instead. Only the desktop comparison can
 * ask for these.
 */
function desktopIdentity(object: ObjectDescriptor): string[] {
	return [...identity(object), String(object.fileDataReference), String(object.fileExtension)];
}

function storedDesktopIdentity(object: RevisionStoreObject): string[] {
	return [...storedIdentity(object), String(object.fileDataReference), String(object.fileExtension)];
}

test('every fixture is indexed under the encoding its own header declares', () => {
	for (const name of [...DESKTOP, ...PACKAGED]) {
		const data = fixture(name);
		const index = open(name);

		try {
			assert.equal(index.encoding, readFileHeader(data, data.length, DEFAULT_READER_OPTIONS).storageFormat);
		}
		finally {
			index.close();
		}
	}
});

// -- Desktop MS-ONESTORE -----------------------------------------------------

for (const name of DESKTOP) {
	test(`${name} indexes the revisions, objects and file data its reader finds`, () => {
		const { graph } = readRevisionStore(fixture(name), DEFAULT_READER_OPTIONS);
		const index = open(name);

		try {
			assert.equal(index.revisionCount, graph.revisions.length);
			assert.equal(index.objectCount, graph.objects.length);
			assert.equal(index.fileDataCount, graph.fileDataObjects.length);
			assert.ok(index.objectCount > 0, 'a fixture with no objects would prove nothing');

			for (const [order, expected] of graph.revisions.entries()) {
				const actual = index.revisionAt(order);

				assert.equal(guid(actual.id), keyOf(expected.id), `revision ${order}`);
				assert.equal(actual.role, expected.role);
				assert.equal(actual.isEncrypted, expected.isEncrypted);
				assert.equal(
					actual.objectSpaceId && guid(actual.objectSpaceId),
					expected.objectSpaceId && keyOf(expected.objectSpaceId));
				assert.equal(
					actual.dependencyId && guid(actual.dependencyId),
					expected.dependencyId && keyOf(expected.dependencyId));

				assert.deepEqual(
					[...index.rootObjectsOf(order)].map(root => [guid(root.objectId), root.role]),
					expected.rootObjects.map(root => [keyOf(root.objectId), root.role]));
				assert.deepEqual(
					[...index.roleAssociationsOf(order)].map(role => [role.role, role.order]),
					expected.roleAssociations.map(role => [role.role, role.order]));
			}

			for (const [order, expected] of graph.objects.entries()) {
				assert.deepEqual(desktopIdentity(index.objectAt(order)), storedDesktopIdentity(expected), `object ${order}`);
			}
		}
		finally {
			index.close();
		}
	});

	test(`${name} names each object's property set instead of decoding it`, () => {
		const { graph } = readRevisionStore(fixture(name), DEFAULT_READER_OPTIONS);
		const index = open(name);
		let decoded = 0;

		try {
			for (const [order, expected] of graph.objects.entries()) {
				const object = index.objectAt(order);
				assert.equal(object.propertySet !== undefined, expected.propertySet !== undefined);
				if (!object.propertySet || !expected.propertySet) continue;

				// The whole contract in one line: bytes fetched from a range,
				// CompactIDs resolved from disk, and the result is what the
				// eager reader decoded while it was parsing.
				assert.deepEqual(
					readPropertySet(
						index.read(object.propertySet),
						index.globalIdTable(object.globalIdScope!),
						DEFAULT_READER_OPTIONS,
						object.propertySet.offset),
					expected.propertySet,
					`object ${order}`);
				decoded++;
			}

			assert.ok(decoded > 20, `expected many property sets, decoded ${decoded}`);
		}
		finally {
			index.close();
		}
	});

	test(`${name} resolves an object and its file data by identifier`, () => {
		const { graph } = readRevisionStore(fixture(name), DEFAULT_READER_OPTIONS);
		const index = open(name);

		try {
			// Lookup answers with the newest declaration of an identifier, so
			// the last one indexed is the one to compare against.
			const last = new Map(graph.objects.map(object => [keyOf(object.id), object]));
			for (const [key, expected] of last) {
				const [identifier, value] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
				const found = index.object({ identifier, value: Number(value) });

				assert.ok(found, `object ${key} is not reachable by identifier`);
				assert.deepEqual(desktopIdentity(found), storedDesktopIdentity(expected));
			}

			assert.equal(index.object({ identifier: '00000000-0000-0000-0000-000000000000', value: 7 }), undefined);

			for (const expected of graph.fileDataObjects) {
				const found = index.fileData(expected.referenceId);
				assert.ok(found, `file data ${expected.referenceId} is not reachable by reference`);
				assert.deepEqual(index.read(found.payload), expected.payload);
			}
		}
		finally {
			index.close();
		}
	});
}

// -- Packaged MS-FSSHTTPB ----------------------------------------------------

for (const name of PACKAGED) {
	test(`${name} indexes every manifest, object group and blob in its package`, () => {
		const data = fixture(name);
		const parsed = readDataElementPackage(data);
		const index = open(name) as PackageIndexedSection;

		try {
			assert.equal(index.schema, parsed.storageManifest.schema);
			assert.equal(index.manifestMappingCount, parsed.storageIndex.manifestMappings.length);
			assert.equal(index.cellMappingCount, parsed.storageIndex.cellMappings.length);
			assert.equal(index.revisionMappingCount, parsed.storageIndex.revisionMappings.length);
			assert.equal(index.manifestRootCount, parsed.storageManifest.roots.length);
			assert.equal(index.objectGroupCount, parsed.objectGroups.size);
			assert.equal(index.revisionCount, parsed.revisionManifests.size);
			assert.equal(index.fileDataCount, parsed.blobs.size);

			assert.deepEqual(
				[...index.cellMappings()].map(mapping => [guid(mapping.cell.first), guid(mapping.cell.second), guid(mapping.id)]),
				parsed.storageIndex.cellMappings.map(mapping => [
					extendedGuidKey(mapping.cell.first),
					extendedGuidKey(mapping.cell.second),
					extendedGuidKey(mapping.id),
				]));
			assert.deepEqual(
				[...index.revisionMappings()].map(mapping => [guid(mapping.revision), guid(mapping.id)]),
				parsed.storageIndex.revisionMappings.map(mapping => [
					extendedGuidKey(mapping.revision),
					extendedGuidKey(mapping.id),
				]));

			// The cell chain is left for the next stage, so what matters here is
			// that every step of it can be followed out of the index alone.
			let followed = 0;
			for (const mapping of index.cellMappings()) {
				const current = index.cellManifest(mapping.id);
				assert.ok(current, 'a cell mapping names a manifest the index does not hold');

				const revisionMapping = [...index.revisionMappings()]
					.find(entry => guid(entry.revision) === guid(current));
				assert.ok(revisionMapping, 'a cell names a revision the storage index does not map');
				assert.notEqual(index.revisionOfElement(revisionMapping.id), undefined);
				followed++;
			}
			assert.equal(followed, parsed.cellManifests.size);

			for (const blob of index.fileDataObjects()) {
				assert.deepEqual(index.read(blob.payload), parsed.blobs.get(blob.key));
			}
		}
		finally {
			index.close();
		}
	});

	test(`${name} records every declaration and its data as a range`, () => {
		const data = fixture(name);
		const parsed = readDataElementPackage(data);
		const index = open(name) as PackageIndexedSection;
		let checked = 0;

		try {
			for (const group of index.objectGroups()) {
				const expected: ObjectGroup | undefined = parsed.objectGroups.get(extendedGuidKey(group.id));
				assert.ok(expected, `object group ${guid(group.id)} is not in the package`);
				assert.equal(group.declarationCount, expected.declarations.length);
				assert.equal(group.dataCount, expected.data.length);

				for (let position = 0; position < group.declarationCount; position++) {
					const declaration = index.declarationAt(group.order, position);
					const declared: ObjectDeclaration = expected.declarations[position];

					assert.deepEqual(
						[guid(declaration.object), declaration.partition, declaration.dataSize,
							declaration.objectReferenceCount, declaration.cellReferenceCount,
							declaration.blob && guid(declaration.blob)],
						[extendedGuidKey(declared.object), declared.partition, declared.dataSize,
							declared.objectReferenceCount, declared.cellReferenceCount,
							declared.blob && extendedGuidKey(declared.blob)]);

					const indexed = index.objectDataAt(group.order, position);
					const decoded: ObjectData = expected.data[position];

					assert.equal(indexed.objectReferences.count, decoded.objectReferences.length);
					assert.equal(indexed.cellReferences.count, decoded.cellReferences.length);
					assert.equal(indexed.blob && guid(indexed.blob), decoded.blob && extendedGuidKey(decoded.blob));
					assert.deepEqual(
						indexed.data && index.read(indexed.data),
						decoded.data,
						`object data ${position} of group ${group.order}`);
					checked++;
				}
			}

			assert.ok(checked > 20, `expected many declarations, checked ${checked}`);
		}
		finally {
			index.close();
		}
	});

	test(`${name} reassembles partitions into the objects its graph builder finds`, () => {
		const data = fixture(name);
		const graph = buildObjectGraph(data, DEFAULT_READER_OPTIONS);
		const index = open(name) as PackageIndexedSection;

		try {
			assert.equal(index.objectCount, graph.objects.length);
			assert.ok(index.objectCount > 0);

			for (const revision of graph.revisions) {
				const indexed = index.revision({ identifier: revision.id.identifier, value: revision.id.value });
				assert.ok(indexed, `revision ${keyOf(revision.id)} is not in the index`);

				// The graph carries an object's revision on the object; the index
				// carries the same relation the other way round.
				const expected = graph.objects.filter(object =>
					object.revisionId && keyOf(object.revisionId) === keyOf(revision.id));

				assert.deepEqual(
					[...index.objectsOf(indexed.order)].map(identity),
					expected.map(storedIdentity),
					`objects of revision ${keyOf(revision.id)}`);
			}

			// The graph resolves an attachment by decoding the object's property
			// set; the index names the blob the declaration pointed at. Both have
			// to arrive at the same payloads.
			const named = new Set<string>();
			for (const object of index.objects()) {
				if (!object.blobId) continue;
				const blob = index.fileData(guid(object.blobId));
				assert.ok(blob, `object ${guid(object.id)} names a blob the index does not hold`);
				named.add(Buffer.from(index.read(blob.payload)).toString('base64'));
			}

			assert.deepEqual(
				[...named].sort(),
				graph.fileDataObjects.map(file => Buffer.from(file.payload).toString('base64')).sort());
		}
		finally {
			index.close();
		}
	});

	test(`${name} keeps each object's reference arrays resolvable from the file`, () => {
		const data = fixture(name);
		const parsed = readDataElementPackage(data);
		const index = open(name) as PackageIndexedSection;
		let checked = 0;

		try {
			// A packaged object has no global-identification table: its
			// CompactIDs mean nothing without these arrays, so the index has to
			// leave them reachable rather than decode and drop them.
			for (const group of index.objectGroups()) {
				const expected: ObjectGroup | undefined = parsed.objectGroups.get(guid(group.id));
				assert.ok(expected);

				for (let position = 0; position < group.dataCount; position++) {
					const stored = index.objectDataAt(group.order, position);
					const beside: ObjectData = expected.data[position];

					assert.deepEqual(
						[...index.extendedGuidsIn(stored.objectReferences.range)].map(guid),
						beside.objectReferences.map(extendedGuidKey),
						`object references ${position} of group ${group.order}`);

					assert.deepEqual(
						[...index.cellIdsIn(stored.cellReferences.range)]
							.map(cell => `${guid(cell.first)}/${guid(cell.second)}`),
						beside.cellReferences.map(cell =>
							`${extendedGuidKey(cell.first)}/${extendedGuidKey(cell.second)}`),
						`cell references ${position} of group ${group.order}`);
					checked++;
				}
			}

			// And the accumulated objects have to keep pointing at a range that
			// still decodes, which is what the next stage will actually call.
			for (const object of index.objects()) {
				if (!object.objectReferences) continue;
				assert.doesNotThrow(() => [...index.extendedGuidsIn(object.objectReferences)]);
			}

			assert.ok(checked > 10, `expected many object data parts, checked ${checked}`);
		}
		finally {
			index.close();
		}
	});
}

// -- The bound ---------------------------------------------------------------

test('a budget far below the section changes nothing but resident bytes', () => {
	for (const name of [...DESKTOP, ...PACKAGED]) {
		const generous = open(name);
		const tight = open(name, TIGHT);

		try {
			assert.equal(tight.revisionCount, generous.revisionCount, name);
			assert.equal(tight.objectCount, generous.objectCount, name);
			assert.equal(tight.fileDataCount, generous.fileDataCount, name);

			for (let order = 0; order < generous.objectCount; order++) {
				assert.deepEqual(
					desktopIdentity(tight.objectAt(order)),
					desktopIdentity(generous.objectAt(order)),
					`${name} object ${order}`);
				assert.deepEqual(tight.objectAt(order).propertySet, generous.objectAt(order).propertySet);
			}
			for (const data of generous.fileDataObjects()) {
				assert.deepEqual(tight.read(tight.fileData(data.key)!.payload), generous.read(data.payload));
			}

			const stats = tight.stats;
			assert.ok(
				stats.cache.highWaterBytes <= TIGHT.cacheBytes!,
				`${name} cache high-water ${stats.cache.highWaterBytes} passed the ${TIGHT.cacheBytes} budget`);
			assert.ok(
				stats.residentBytes <= TIGHT.cacheBytes! + TIGHT.windowBytes!,
				`${name} held ${stats.residentBytes} bytes, past the budget plus one window`);
		}
		finally {
			generous.close();
			tight.close();
		}
	}
});

test('resident bytes do not follow the size of the section', () => {
	// The larger packaged fixture holds more than twice the objects of the
	// smaller. Under one budget, both must cost the same.
	const small = open('testOneNoteFromOffice365.one', TIGHT);
	const large = open('testOneNoteFromOffice365-2.one', TIGHT);
	const desktop = open('handwriting_recognition.one', TIGHT);

	try {
		assert.ok(large.objectCount > small.objectCount * 2, 'the fixtures are not different enough to prove anything');

		assert.equal(large.stats.residentBytes, small.stats.residentBytes);
		assert.equal(desktop.stats.residentBytes, small.stats.residentBytes);
		assert.equal(large.stats.cache.highWaterBytes, small.stats.cache.highWaterBytes);
		assert.ok(large.stats.cache.records > small.stats.cache.records, 'the larger section writes more descriptors');
	}
	finally {
		small.close();
		large.close();
		desktop.close();
	}
});

test('closing an index removes the temporary files it wrote', () => {
	const index = open('testOneNote.one') as IndexedSection;
	const pages = index.store.backingFilePath;
	const buckets = index.store.indexFilePath;

	assert.ok(nodeFs.existsSync(pages));
	index.close();

	assert.equal(nodeFs.existsSync(pages), false);
	assert.equal(nodeFs.existsSync(buckets), false);
});

// -- Validation --------------------------------------------------------------

test('a structural fault is reported with the code the existing reader gives it', () => {
	const desktop = fixture('testOneNote.one');
	const store = readRevisionStore(desktop, DEFAULT_READER_OPTIONS);
	const damaged = desktop.slice();
	damaged[store.header.rootFileNodeList!.offset] ^= 0xff;

	assert.throws(
		() => readRevisionStore(damaged, DEFAULT_READER_OPTIONS),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_FILE_NODE_HEADER_MAGIC');
	assert.throws(
		() => indexSection(new Uint8ArrayByteSource(damaged)),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_FILE_NODE_HEADER_MAGIC');

	const packaged = fixture('testOneNoteFromOffice365.one');
	const padded = packaged.slice();
	padded[padded.length - 1] = 0x01;

	assert.throws(
		() => readDataElementPackage(padded),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_FSSHTTPB_TRAILING');
	assert.throws(
		() => indexSection(new Uint8ArrayByteSource(padded)),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_FSSHTTPB_TRAILING');
});

test('reader ceilings still bound an index, in both encodings', () => {
	for (const name of ['testOneNote.one', 'testOneNoteFromOffice365.one']) {
		assert.throws(
			() => indexSection(new Uint8ArrayByteSource(fixture(name)), {
				reader: { ...DEFAULT_READER_OPTIONS, maxObjects: 1 },
			}),
			(error: unknown) => (error as { code?: string }).code === 'ONENOTE_OBJECT_LIMIT',
			name);
	}

	// The asset caps are the ones that matter most here, because indexing never
	// reads a payload: they have to be enforced against the declared length or
	// they would stop being enforced at all.
	for (const reader of [
		{ ...DEFAULT_READER_OPTIONS, maxAssetBytes: 16 },
		{ ...DEFAULT_READER_OPTIONS, maxTotalAssetBytes: 16 },
	]) {
		assert.throws(
			() => indexSection(new Uint8ArrayByteSource(fixture('testOneNote.one')), { reader }),
			(error: unknown) => (error as { code?: string }).code === 'ONENOTE_ASSET_LIMIT');
	}
});

test('an artifact that is not a loose section is refused, not guessed at', () => {
	assert.throws(
		() => indexSection(new Uint8ArrayByteSource(fixture('makecab-lzx-notebook.onepkg'))),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_NOT_A_SECTION');
});
