import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { test } from 'node:test';

import {
	ByteSourceError,
	FileDescriptorByteSource,
	Uint8ArrayByteSource,
} from '../src/storage/byte-source';
import { FsSink } from '../src/sinks';
import { PagedKeyValueStore } from '../src/storage/paged-key-value-store';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array | undefined): string | undefined =>
	value && new TextDecoder().decode(value);

test('Uint8Array ByteSource performs owned positional reads with bounds errors', () => {
	const data = bytes('abcdef');
	const source = new Uint8ArrayByteSource(data);
	const result = source.read(2, 3);

	assert.equal(text(result), 'cde');
	result[0] = 0;
	assert.equal(text(source.read(2, 3)), 'cde', 'returned data does not alias the source');
	assert.throws(
		() => source.read(5, 2),
		(error: unknown) =>
			error instanceof ByteSourceError
			&& error.code === 'BYTE_SOURCE_OUT_OF_BOUNDS'
			&& /2 bytes at offset 5/.test(error.message));
	assert.throws(
		() => source.read(Number.NaN, 1),
		(error: unknown) => (error as { code?: string }).code === 'BYTE_SOURCE_INVALID_RANGE');
});

test('file descriptor ByteSource reads positionally and detects later truncation', () => {
	const directory = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-source-test-'));
	const file = nodePath.join(directory, 'bytes');
	nodeFs.writeFileSync(file, bytes('0123456789'));
	const fd = nodeFs.openSync(file, 'r');

	try {
		const source = new FileDescriptorByteSource(fd);
		assert.equal(text(source.read(6, 3)), '678');
		assert.equal(text(source.read(1, 2)), '12', 'reads do not share a cursor');

		nodeFs.truncateSync(file, 2);
		assert.throws(
			() => source.read(1, 3),
			(error: unknown) =>
				(error as { code?: string }).code === 'BYTE_SOURCE_SHORT_READ'
				&& /file may have been truncated/.test((error as Error).message));
	} finally {
		nodeFs.closeSync(fd);
		nodeFs.rmSync(directory, { recursive: true });
	}
});

test('paged store deterministically replaces exact binary keys', () => {
	const store = new PagedKeyValueStore({ pageSize: 64, cacheBytes: 128, bucketCount: 16 });
	try {
		const key = new Uint8Array([0, 255, 1]);
		store.set(key, bytes('first'));
		store.set(bytes('other'), bytes('second'));
		store.set(key, bytes('replacement'));

		assert.equal(store.size, 2, 'an updated key is counted once');
		assert.equal(text(store.get(key)), 'replacement');
		assert.equal(text(store.get(bytes('other'))), 'second');
		assert.equal(store.get(bytes('missing')), undefined);
		assert.equal(store.has(key), true);
		assert.equal(store.has(bytes('missing')), false);

		const result = store.get(key)!;
		result[0] = 0;
		assert.equal(text(store.get(key)), 'replacement', 'returned values are owned copies');
	} finally {
		store.close();
	}
});

test('an update appends a new chain head rather than rewriting in place', () => {
	const store = new PagedKeyValueStore({ pageSize: 128, cacheBytes: 256, bucketCount: 8 });
	try {
		store.set(bytes('k'), bytes('v1'));
		const afterInsert = store.cacheStats.records;

		store.set(bytes('k'), bytes('v2'));
		store.set(bytes('k'), bytes('v3'));

		assert.equal(store.cacheStats.records, afterInsert + 2, 'each update appends a record');
		assert.equal(store.size, 1, 'appended heads do not inflate the unique-key count');
		assert.equal(text(store.get(bytes('k'))), 'v3', 'the newest head is found first');
	} finally {
		store.close();
	}
});

test('hash collisions remain exact-key safe', () => {
	const store = new PagedKeyValueStore({
		pageSize: 64,
		cacheBytes: 64,
		bucketCount: 32,
		keyHash: () => 7,
	});
	try {
		store.set(bytes('alpha'), bytes('A'));
		store.set(bytes('beta'), bytes('B'));
		store.set(bytes('alpha'), bytes('A2'));

		assert.equal(text(store.get(bytes('alpha'))), 'A2');
		assert.equal(text(store.get(bytes('beta'))), 'B');
		assert.equal(store.get(bytes('gamma')), undefined, 'a colliding miss is still a miss');
		assert.equal(store.size, 2);
		assert.ok(store.cacheStats.chainSteps > 0, 'lookups walk the on-disk chain');
	} finally {
		store.close();
	}
});

test('a single bucket keeps every key distinct under forced total collision', () => {
	// One bucket means one chain: correctness then rests entirely on comparing
	// stored key bytes, never on the hash.
	const store = new PagedKeyValueStore({ pageSize: 128, cacheBytes: 256, bucketCount: 1 });
	const keys = Array.from({ length: 50 }, (_, index) => `k${index}`);
	try {
		for (const key of keys) store.set(bytes(key), bytes(`v${key}`));
		for (const key of keys) assert.equal(text(store.get(bytes(key))), `v${key}`);

		assert.equal(store.size, keys.length);
		assert.ok(store.cacheStats.residentBytes <= 256);
	} finally {
		store.close();
	}
});

test('fixed pages persist in a temp file and LRU high-water stays within budget', () => {
	const store = new PagedKeyValueStore({ pageSize: 64, cacheBytes: 128, bucketCount: 16 });
	const pages = store.backingFilePath;
	const index = store.indexFilePath;
	try {
		for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
			store.set(bytes(key), new Uint8Array(20).fill(key.charCodeAt(0)));
		}

		assert.ok(nodeFs.statSync(pages).size >= 3 * 64, 'records spill across fixed-size pages');
		assert.equal(nodeFs.statSync(pages).size % 64, 0, 'the backing file is a whole number of pages');
		assert.equal(store.cacheStats.pages, 2);
		assert.equal(store.cacheStats.residentBytes, 128);
		assert.ok(store.cacheStats.highWaterBytes <= store.cacheStats.budgetBytes);

		const misses = store.cacheStats.misses;
		assert.equal(store.get(bytes('a'))?.[0], 'a'.charCodeAt(0));
		assert.ok(store.cacheStats.misses > misses, 'an evicted page is re-read from disk');
		assert.ok(store.cacheStats.residentBytes <= 128);
	} finally {
		store.close();
	}
	assert.equal(nodeFs.existsSync(pages), false, 'closing removes the page file');
	assert.equal(nodeFs.existsSync(index), false, 'closing removes the bucket table too');
});

test('the index is on disk: heap stays flat as cardinality grows tenfold', () => {
	// The point of the disk-backed bucket table is that nothing in memory grows
	// with the record count. Cache high-water and the index file's size are the
	// observable proxies: both must be identical at 200 and at 2,000 keys.
	const pageSize = 256;
	const cacheBytes = 1024;
	const bucketCount = 512;

	const fill = (count: number) => {
		const store = new PagedKeyValueStore({ pageSize, cacheBytes, bucketCount });
		for (let index = 0; index < count; index++) {
			store.set(bytes(`key-${index}`), bytes(`value-${index}`));
		}
		return store;
	};

	const small = fill(200);
	const large = fill(2000);
	try {
		for (const [store, count] of [[small, 200], [large, 2000]] as const) {
			assert.equal(store.size, count, 'every key is counted exactly once');
			assert.equal(store.cacheStats.budgetBytes, cacheBytes);
			assert.ok(
				store.cacheStats.highWaterBytes <= cacheBytes,
				`high-water ${store.cacheStats.highWaterBytes} exceeded the ${cacheBytes}-byte budget`);
			assert.equal(store.cacheStats.pages, cacheBytes / pageSize);
			assert.equal(
				nodeFs.statSync(store.indexFilePath).size,
				bucketCount * 8,
				'the bucket table is sized by bucket count, not by record count');
		}

		assert.equal(
			large.cacheStats.highWaterBytes,
			small.cacheStats.highWaterBytes,
			'ten times the keys does not raise resident memory');

		// The data itself is on disk, far past what the cache could ever hold.
		const pageBytes = nodeFs.statSync(large.backingFilePath).size;
		assert.ok(pageBytes > 10 * cacheBytes, `expected the pages to outgrow the cache, got ${pageBytes}`);

		for (const index of [0, 1, 199, 1000, 1999]) {
			assert.equal(text(large.get(bytes(`key-${index}`))), `value-${index}`);
		}
		assert.equal(large.get(bytes('key-2000')), undefined);

		large.set(bytes('key-1000'), bytes('updated'));
		assert.equal(large.size, 2000, 'an update at high cardinality adds no key');
		assert.equal(text(large.get(bytes('key-1000'))), 'updated');
		assert.equal(text(large.get(bytes('key-1001'))), 'value-1001', 'neighbours are untouched');
		assert.ok(large.cacheStats.highWaterBytes <= cacheBytes);
	} finally {
		small.close();
		large.close();
	}
});

test('paged store rejects impossible budgets, oversized records, and use after close', () => {
	assert.throws(
		() => new PagedKeyValueStore({ pageSize: 64, cacheBytes: 63 }),
		(error: unknown) =>
			(error as { code?: string }).code === 'PAGED_STORE_INVALID_OPTIONS'
			&& /at least one page/.test((error as Error).message));
	assert.throws(
		() => new PagedKeyValueStore({ bucketCount: 0 }),
		(error: unknown) =>
			(error as { code?: string }).code === 'PAGED_STORE_INVALID_OPTIONS'
			&& /bucketCount/.test((error as Error).message));

	const store = new PagedKeyValueStore({ pageSize: 64, cacheBytes: 64, bucketCount: 4 });
	assert.throws(
		() => store.set(bytes('key'), new Uint8Array(40)),
		(error: unknown) =>
			(error as { code?: string }).code === 'PAGED_STORE_RECORD_TOO_LARGE'
			&& /holds at most 56/.test((error as Error).message));

	const hostile = new PagedKeyValueStore({ bucketCount: 4, keyHash: () => -1 });
	try {
		assert.throws(
			() => hostile.set(bytes('key'), bytes('value')),
			(error: unknown) => (error as { code?: string }).code === 'PAGED_STORE_INVALID_HASH');
	} finally {
		hostile.close();
	}

	store.close();
	assert.throws(
		() => store.get(bytes('key')),
		(error: unknown) => (error as { code?: string }).code === 'PAGED_STORE_CLOSED');
	assert.doesNotThrow(() => store.close(), 'closing twice is harmless');
});

test('a page cache never holds more than its budget, even mid-miss', () => {
	// Four pages of budget and far more pages than that, so every read past
	// the first four is a miss that has to evict before it allocates.
	const store = new PagedKeyValueStore({ pageSize: 4096, cacheBytes: 4 * 4096, bucketCount: 64 });

	try {
		const keys: Uint8Array[] = [];
		for (let index = 0; index < 200; index++) {
			const key = new Uint8Array(8);
			new DataView(key.buffer).setUint32(0, index, true);
			// Half a page each, so two records to a page and a hundred pages.
			store.set(key, new Uint8Array(2000).fill(index & 0xff));
			keys.push(key);
		}

		// Read them back out of order, which is the worst case for an LRU.
		for (let round = 0; round < 3; round++) {
			for (let index = 0; index < keys.length; index++) {
				const at = (index * 61 + round) % keys.length;
				const value = store.get(keys[at]);
				assert.ok(value, `key ${at} went missing`);

				// Checked inside the loop, so a cache that goes over the budget
				// only while a page is in flight is still caught: a `get` is
				// exactly the moment a miss allocates.
				const stats = store.cacheStats;
				assert.ok(stats.residentBytes <= stats.budgetBytes,
					`${stats.residentBytes} resident against a ${stats.budgetBytes} budget`);
				assert.ok(stats.highWaterBytes <= stats.budgetBytes,
					`high water reached ${stats.highWaterBytes}, over the ${stats.budgetBytes} budget`);
			}
		}

		const stats = store.cacheStats;
		assert.ok(stats.misses > 100, `only ${stats.misses} misses; the cache was not pressured`);
		assert.equal(stats.highWaterBytes, stats.budgetBytes, 'the cache should have filled');

		// And the copies it handed out are bounded by a page, which is what
		// the budget reserves for them.
		assert.ok(stats.copyHighWaterBytes > 0, 'nothing was copied out, so nothing was measured');
		assert.ok(stats.copyHighWaterBytes <= store.pageSize,
			`a ${stats.copyHighWaterBytes}-byte copy out of a ${store.pageSize}-byte page`);
	}
	finally {
		store.close();
	}
});

test('a store that cannot finish opening leaves nothing behind', () => {
	const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-rollback-'));

	// The failure being tested lands between two syscalls: the private
	// directory and the first descriptor exist, and the second open fails. The
	// real cause of that is running out of descriptors, so that is the cause
	// used here — the process opens them until it cannot, then gives back just
	// enough for the first open to succeed and the second to fail.
	//
	// Nothing is mocked, because the module namespace cannot be written to and
	// because a mock would be testing the test.
	const hogs: number[] = [];

	try {
		const spare = nodePath.join(root, 'spare');
		nodeFs.writeFileSync(spare, '');

		for (let index = 0; index < 200_000; index++) {
			try {
				hogs.push(nodeFs.openSync(spare, 'r'));
			}
			catch {
				break;
			}
		}

		if (hogs.length === 0 || hogs.length >= 200_000) {
			// No descriptor limit worth reaching on this platform. The rollback
			// is still exercised by the read-only temporary directory case in
			// the CLI tests; this one has nothing to say here.
			return;
		}

		// One free descriptor: enough for the pages file, not for the buckets.
		nodeFs.closeSync(hogs.pop()!);

		const before = nodeFs.readdirSync(root).sort();

		assert.throws(
			() => new PagedKeyValueStore({
				pageSize: 4096, cacheBytes: 4096, bucketCount: 64, tempDirectory: root,
			}),
			(error: { code?: string }) => error.code === 'EMFILE' || error.code === 'ENFILE',
			'the descriptor failure should survive the rollback rather than being replaced');

		assert.deepEqual(nodeFs.readdirSync(root).sort(), before,
			'the private directory should have been removed when the store failed to open');
	}
	finally {
		for (const fd of hogs) {
			try {
				nodeFs.closeSync(fd);
			}
			catch { /* already closed */ }
		}
		nodeFs.rmSync(root, { recursive: true, force: true });
	}
});

// -- Files left open by an exit that does not unwind -------------------------

test('a forced cleanup deletes the files still being written', async () => {
	const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-forced-'));

	try {
		const sink = new FsSink(root, false);

		// One finished, two mid-write. The finished one is the control: a
		// forced cleanup must not touch a file that was closed properly.
		const finished = await sink.open('notes/done.md');
		await finished.write(new TextEncoder().encode('# Done\n'));
		await finished.close();

		assert.equal(sink.openCount, 0, 'a closed writer should deregister itself');

		const note = await sink.open('notes/partial.md');
		await note.write(new TextEncoder().encode('---\ntitle: "half a"'));

		const asset = await sink.open('notes/attachments/partial.png');
		await asset.write(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

		assert.equal(sink.openCount, 2, 'both open writers should be tracked');
		assert.ok(nodeFs.existsSync(nodePath.join(root, 'notes/partial.md')),
			'the partial note should be on disk, which is the problem being solved');

		// The forced exit. Nothing awaits, nothing unwinds.
		sink.abortAll();

		assert.equal(sink.openCount, 0);
		assert.equal(nodeFs.existsSync(nodePath.join(root, 'notes/partial.md')), false,
			'a note that was still being written should have been deleted');
		assert.equal(nodeFs.existsSync(nodePath.join(root, 'notes/attachments/partial.png')), false,
			'an asset that was still being written should have been deleted');
		assert.equal(
			nodeFs.readFileSync(nodePath.join(root, 'notes/done.md'), 'utf8'), '# Done\n',
			'a file that was closed properly should survive a forced cleanup');

		// Idempotent, in every order the exit paths can reach it: a second
		// signal, then the `exit` handler, then an `abort` unwinding late.
		sink.abortAll();
		sink.abortAll();
		await note.abort?.();
		await note.close();
		await asset.close();

		assert.equal(sink.openCount, 0);
	}
	finally {
		nodeFs.rmSync(root, { recursive: true, force: true });
	}
});

test('a writer that closed normally is not deleted by a later abort', async () => {
	const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'one2md-settled-'));

	try {
		const sink = new FsSink(root, false);
		const writer = await sink.open('note.md');

		await writer.write(new TextEncoder().encode('kept'));
		await writer.close();

		// The ordinary unwinding calls `abort` on the way out of a failure, and
		// a failure can be raised after the note was closed — recording it, for
		// instance. Aborting then must not take the finished file with it.
		await writer.abort?.();
		sink.abortAll();

		assert.equal(nodeFs.readFileSync(nodePath.join(root, 'note.md'), 'utf8'), 'kept');
	}
	finally {
		nodeFs.rmSync(root, { recursive: true, force: true });
	}
});
