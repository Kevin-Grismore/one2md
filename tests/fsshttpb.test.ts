/**
 * The MS-FSSHTTPB primitives, checked two ways.
 *
 * Hand-built bytes pin each encoding width against the spec. Then the two
 * packaged fixtures are walked end to end, which is the check that actually
 * matters: the framing is dense and self-delimiting, so a wrong width
 * desynchronises within a few bytes and the nesting stops closing. A walk that
 * balances every compound object over tens of kilobytes, and whose data
 * elements add up, cannot be getting the encodings wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

import { Cursor, NIL_GUID } from '../src/fsshttpb/binary';
import { DATA_ELEMENT_PACKAGE_TYPE, DATA_ELEMENT_TYPE, DataElementType, readDataElementHeader } from '../src/fsshttpb/data-element';
import { PACKAGING_OBJECT_TYPE, walk, WalkNode } from '../src/fsshttpb/walk';
import { readFileHeader } from '../src/onenote-file/onestore/file-header';
import { DEFAULT_READER_OPTIONS } from '../src/onenote-file/onestore/options';
import { FIXTURES } from './helpers';

const PACKAGED = ['testOneNoteFromOffice365.one', 'testOneNoteFromOffice365-2.one'];

function fixture(name: string): Uint8Array {
	return new Uint8Array(nodeFs.readFileSync(nodePath.join(FIXTURES, name)));
}

function cursor(...bytes: number[]): Cursor {
	return new Cursor(new Uint8Array(bytes));
}

const GUID_BYTES = [
	0x78, 0x56, 0x34, 0x12, 0x34, 0x12, 0x78, 0x56,
	0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22, 0x33, 0x44,
];
const GUID = '12345678-1234-5678-9abc-def011223344';

test('a GUID is read in the mixed-endian layout Windows writes', () => {
	assert.equal(cursor(...GUID_BYTES).readGuid(), GUID);
});

test('compact integers decode at every width', () => {
	// Zero is a single zero byte; every other width marks itself with its
	// lowest set bit and carries the value above that marker.
	assert.equal(cursor(0x00).readCompactUint(), 0);
	assert.equal(cursor(0x03).readCompactUint(), 1, '7-bit');
	assert.equal(cursor(0xc9).readCompactUint(), 100, '7-bit');
	assert.equal(cursor(0xff).readCompactUint(), 127, '7-bit, largest');
	assert.equal(cursor(0xa2, 0x0f).readCompactUint(), 1000, '14-bit');
	assert.equal(cursor(0x04, 0x35, 0x0c).readCompactUint(), 100_000, '21-bit');
	assert.equal(cursor(0x10, 0x48, 0xe8, 0x01, 0x00).readCompactUint(), 1_000_000, '35-bit');
	assert.equal(cursor(0x80, 0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00).readCompactUint(),
		0x04030201, '64-bit');
});

test('a compact integer consumes exactly its own width', () => {
	const reader = cursor(0x03, 0xa2, 0x0f, 0x00, 0xc9);

	assert.equal(reader.readCompactUint(), 1);
	assert.equal(reader.position, 1);
	assert.equal(reader.readCompactUint(), 1000);
	assert.equal(reader.position, 3);
	assert.equal(reader.readCompactUint(), 0);
	assert.equal(reader.readCompactUint(), 100);
	assert.ok(reader.atEnd);
});

test('an integer too large to represent exactly is refused, not rounded', () => {
	// 2^53, the first integer a double cannot separate from its neighbour.
	assert.throws(
		() => cursor(0x80, 0, 0, 0, 0, 0, 0, 0x20, 0x00).readCompactUint(),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_FSSHTTPB_HUGE_INTEGER');
});

test('Extended GUIDs decode at every width', () => {
	assert.deepEqual(cursor(0x00).readExtendedGuid(), { identifier: NIL_GUID, value: 0 });
	assert.deepEqual(cursor(0x2c, ...GUID_BYTES).readExtendedGuid(), { identifier: GUID, value: 5 }, '5-bit');
	assert.deepEqual(cursor(0x20, 0x40, ...GUID_BYTES).readExtendedGuid(), { identifier: GUID, value: 0x100 }, '10-bit');
	assert.deepEqual(cursor(0x40, 0x00, 0x08, ...GUID_BYTES).readExtendedGuid(), { identifier: GUID, value: 0x1000 }, '17-bit');
	assert.deepEqual(cursor(0x80, 0x01, 0x00, 0x02, 0x00, ...GUID_BYTES).readExtendedGuid(),
		{ identifier: GUID, value: 0x20001 }, '32-bit');
});

test('each Extended GUID width consumes the bytes the spec gives it', () => {
	for (const [bytes, width] of [
		[[0x00], 1],
		[[0x2c, ...GUID_BYTES], 17],
		[[0x20, 0x40, ...GUID_BYTES], 18],
		[[0x40, 0x00, 0x08, ...GUID_BYTES], 19],
		[[0x80, 0x01, 0x00, 0x02, 0x00, ...GUID_BYTES], 21],
	] as [number[], number][]) {
		const reader = new Cursor(new Uint8Array(bytes));
		reader.readExtendedGuid();
		assert.equal(reader.position, width, `a ${width}-byte Extended GUID`);
	}
});

test('a byte that begins no Extended GUID encoding is refused', () => {
	assert.throws(
		() => cursor(0x01, ...GUID_BYTES).readExtendedGuid(),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_FSSHTTPB_EXTENDED_GUID');
});

test('stream object headers decode in all four forms', () => {
	// 16-bit start: form 0, compound, type 0x0b, length 3.
	const short = cursor(0b0101_1100, 0b0000_0110).readStreamObjectHeader();
	assert.deepEqual(
		{ kind: short.kind, compound: short.compound, type: short.type, length: short.length, headerLength: short.headerLength },
		{ kind: 'start', compound: true, type: 0x0b, length: 3, headerLength: 2 });

	// 8-bit end: form 1, type 0x0b.
	const end = cursor(0b0010_1101).readStreamObjectHeader();
	assert.equal(end.kind, 'end');
	assert.equal(end.type, 0x0b);
	assert.equal(end.headerLength, 1);

	// 16-bit end: form 3, type 0x7a.
	const longEnd = cursor(0xeb, 0x01).readStreamObjectHeader();
	assert.equal(longEnd.kind, 'end');
	assert.equal(longEnd.type, 0x7a);
	assert.equal(longEnd.headerLength, 2);
});

test('a 32-bit start header with a saturated length reads the length that follows', () => {
	// Form 2, compound, type 1, length field all ones, then 1000 as a compact integer.
	const header = (0x02 | 0x04 | (1 << 3) | (0x7fff << 17)) >>> 0;
	const bytes = [header & 0xff, (header >>> 8) & 0xff, (header >>> 16) & 0xff, (header >>> 24) & 0xff, 0xa2, 0x0f];
	const read = cursor(...bytes).readStreamObjectHeader();

	assert.equal(read.kind, 'start');
	assert.equal(read.type, 1);
	assert.equal(read.length, 1000);
	assert.equal(read.headerLength, 6, 'the trailing compact integer counts toward the header');
});

test('reads never pass the end of the structure they were given', () => {
	assert.throws(
		() => cursor(0x03).readGuid(),
		(error: unknown) => (error as { code?: string }).code === 'ONENOTE_FSSHTTPB_RANGE');
});

for (const name of PACKAGED) {
	test(`${name} is a packaging envelope the header already accepts`, () => {
		const data = fixture(name);
		const header = readFileHeader(data, data.length, DEFAULT_READER_OPTIONS);

		assert.equal(header.storageFormat, 'file-synchronization-package');
		assert.equal(header.fileKind, 'section');
		assert.deepEqual(header.diagnostics, []);
	});

	test(`${name} walks as one balanced packaging object`, () => {
		const data = fixture(name);
		const result = walk(data);

		assert.equal(result.roots.length, 1, 'the package is a single root object');
		assert.equal(result.roots[0].type, PACKAGING_OBJECT_TYPE);
		assert.equal(result.roots[0].children.length, 1, 'the packaging object holds one data element package');
		assert.ok(result.end > 20_000, 'the walk covered the real payload, not a stub');
		assert.ok(result.trailing > 0, 'OneNote pads the file after the package');
		assert.equal(result.end + result.trailing, data.length);
	});

	test(`${name} sorts into data elements that account for the whole package`, () => {
		const data = fixture(name);
		const elements = walk(data).roots[0].children[0].children;

		assert.ok(elements.length > 0);
		for (const element of elements) assert.equal(element.type, DATA_ELEMENT_TYPE);

		// Each element's identity must consume its declared length exactly. There
		// is no padding to hide a mis-sized Extended GUID or serial number in.
		const counts = new Map<DataElementType, number>();
		for (const element of elements) {
			const header = readDataElementHeader(data, element);
			assert.equal(header.length, element.dataLength, 'the header fills the element data exactly');
			counts.set(header.type, (counts.get(header.type) ?? 0) + 1);
		}

		const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
		assert.equal(total, elements.length, 'the kinds partition the package');

		// A section is one storage index, one storage manifest, and then the
		// cell manifests, revision manifests and object groups that carry it.
		assert.equal(counts.get(DataElementType.StorageIndex), 1);
		assert.equal(counts.get(DataElementType.StorageManifest), 1);
		assert.ok((counts.get(DataElementType.CellManifest) ?? 0) > 0);
		assert.equal(counts.get(DataElementType.RevisionManifest), counts.get(DataElementType.ObjectGroup),
			'every revision manifest has an object group');
	});

	test(`${name} names the same storage index the file header does`, () => {
		// Two independent decoders — the vendored header reader and these
		// primitives — arriving at one GUID from different offsets and different
		// Extended GUID code. That agreement is the check.
		const data = fixture(name);
		const declared = readFileHeader(data, data.length, DEFAULT_READER_OPTIONS).storageIndexId;
		const elements = walk(data).roots[0].children[0].children;

		const index = elements
			.map(element => readDataElementHeader(data, element))
			.find(header => header.type === DataElementType.StorageIndex);

		assert.ok(index, 'the package holds a storage index');
		assert.equal(index.id.identifier, declared?.identifier);
		assert.equal(index.id.value, declared?.value);
	});
}

test('the desktop fixtures are not packaged, and are left to the other reader', () => {
	for (const name of ['testOneNote2016.one', 'handwriting_recognition.one']) {
		const data = fixture(name);
		assert.equal(readFileHeader(data, data.length, DEFAULT_READER_OPTIONS).storageFormat, 'revision-store');
	}
});

test('the two packagings agree on their internal shape', () => {
	// Not a spec requirement — a consistency check across two independently
	// authored files, which is what would catch an encoding that happened to
	// work on one of them.
	for (const name of PACKAGED) {
		const root = walk(fixture(name)).roots[0];
		const depth = (node: WalkNode): number =>
			node.children.length === 0 ? 1 : 1 + Math.max(...node.children.map(depth));

		assert.equal(root.dataLength, 33, 'storage index plus cell schema GUID');
		assert.equal(root.children[0].type, DATA_ELEMENT_PACKAGE_TYPE);
		assert.equal(depth(root), 5, `${name} nests to the same depth`);
	}
});
