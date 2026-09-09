import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';

const PAGE_HEADER_BYTES = 8;
/** keyLength, valueLength, and the low and high halves of the chain link. */
const RECORD_HEADER_BYTES = 16;
const BUCKET_ENTRY_BYTES = 8;
/** Chain links are stored biased by one so that zero can mean "end of chain". */
const NIL_LINK = 0;

interface RecordLocation {
	address: number;
	pageNumber: number;
	offset: number;
	keyLength: number;
	valueLength: number;
	previous: number;
}

export interface PagedKeyValueStoreOptions {
	/** Size of every page in the backing file. */
	pageSize?: number;
	/** Maximum bytes occupied by cached pages. Must hold at least one page. */
	cacheBytes?: number;
	/**
	 * Number of on-disk hash buckets. This fixes the index file's size for the
	 * lifetime of the store; it trades disk for shorter collision chains.
	 */
	bucketCount?: number;
	/** Parent directory for the private temporary directory. */
	tempDirectory?: string;
	/**
	 * Bucket hash over the key bytes, as a uint32. Only the bucket is derived
	 * from it, so a weak or colliding hash costs lookup steps, never accuracy.
	 * Primarily useful for testing collision handling.
	 */
	keyHash?: (key: Uint8Array) => number;
}

export interface PageCacheStats {
	readonly budgetBytes: number;
	readonly residentBytes: number;
	readonly highWaterBytes: number;
	readonly pages: number;
	readonly hits: number;
	readonly misses: number;
	/** Records appended, including superseded heads left behind by updates. */
	readonly records: number;
	/** Records visited while walking collision chains. */
	readonly chainSteps: number;
	/** The largest record handed to a caller, which the caller then holds. */
	readonly copyHighWaterBytes: number;
}

export class PagedStoreError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = 'PagedStoreError';
		this.code = code;
	}
}

const defaultHash = (key: Uint8Array): number => {
	const digest = createHash('sha256').update(key).digest();
	return digest.readUInt32LE(0);
};

function positiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new PagedStoreError(
			'PAGED_STORE_INVALID_OPTIONS',
			`${name} must be a positive safe integer; received ${value}.`);
	}
}

/**
 * The errnos that mean "the disk this store lives on will not take more".
 *
 * Worth naming because they are the one failure a bounded conversion invites:
 * memory is traded for disk, so a store on a small `/tmp` or under a quota can
 * run out where an in-memory conversion would not have. The errno is kept as
 * the code so a caller can offer advice for the specific cause, and the
 * message names the directory — which is the thing to move or make room on.
 */
const OUT_OF_SPACE = new Set(['ENOSPC', 'EDQUOT', 'EFBIG', 'EROFS']);

/** Close a descriptor that may not have been opened, without ever throwing. */
function closeQuietly(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		nodeFs.closeSync(fd);
	}
	catch { /* rolling back a failure is not a place to add one */ }
}

function errnoOf(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === 'string' ? code : undefined;
}

/**
 * Re-throw a space failure as a store failure that says where and what.
 *
 * Anything else passes through untouched: guessing at an unfamiliar errno
 * would replace a precise message with a vague one.
 */
function rethrowSpace(error: unknown, directory: string, what: string): never {
	const errno = errnoOf(error);
	if (!errno || !OUT_OF_SPACE.has(errno)) throw error;

	const reason = errno === 'EDQUOT'
		? 'a disk quota was reached'
		: errno === 'EROFS'
			? 'the filesystem is read-only'
			: 'the filesystem is full';

	throw new PagedStoreError(
		errno,
		`The ${what} could not be written because ${reason}: ${directory}. `
		+ 'A bounded conversion trades memory for temporary disk, so it needs room there.');
}

function writeAll(fd: number, data: Uint8Array, position: number, what: string, directory: string): void {
	let written = 0;
	while (written < data.byteLength) {
		let count: number;
		try {
			count = nodeFs.writeSync(fd, data, written, data.byteLength - written, position + written);
		}
		catch (error) {
			rethrowSpace(error, directory, what);
		}

		if (count === 0) {
			throw new PagedStoreError(
				'PAGED_STORE_SHORT_WRITE',
				`The ${what} accepted only ${written} of ${data.byteLength} bytes at offset ${position}.`);
		}
		written += count;
	}
}

function readAll(fd: number, into: Uint8Array, position: number, what: string): void {
	let read = 0;
	while (read < into.byteLength) {
		const count = nodeFs.readSync(fd, into, read, into.byteLength - read, position + read);
		if (count === 0) {
			throw new PagedStoreError(
				'PAGED_STORE_TRUNCATED_FILE',
				`The ${what} ended after ${read} of ${into.byteLength} bytes at offset ${position}; the temporary file may have been truncated.`);
		}
		read += count;
	}
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

/**
 * A temporary-file-backed binary key/value store whose index is also on disk.
 *
 * Records live append-only inside fixed-size slotted pages. The index is a
 * fixed-size table of hash buckets in a second file; each bucket holds the
 * address of its newest record, and every record carries the address of the
 * previous record in its bucket. Lookups therefore walk a chain through the
 * page cache instead of consulting anything held in heap.
 *
 * Nothing in memory grows with the record count: the heap holds fixed counters
 * and the byte-budgeted page cache, and the bucket table's size is fixed when
 * the store is constructed. An update appends a new chain head rather than
 * rewriting a record in place, so the newest value is found first while older
 * copies stay reachable only as dead weight in the backing file.
 *
 * The bucket hash decides only which chain a key belongs to. Every candidate is
 * confirmed by comparing the stored key bytes, so colliding hashes can never
 * return or replace the wrong record.
 */
export class PagedKeyValueStore {
	readonly pageSize: number;
	readonly cacheBudgetBytes: number;
	readonly bucketCount: number;
	readonly backingFilePath: string;
	readonly indexFilePath: string;

	readonly #directory: string;
	readonly #pagesFd: number;
	readonly #indexFd: number;
	readonly #hash: (key: Uint8Array) => number;
	readonly #cache = new Map<number, Uint8Array>();
	readonly #bucketScratch = new Uint8Array(BUCKET_ENTRY_BYTES);
	readonly #bucketView: DataView;
	#pageCount = 0;
	#activePage = -1;
	#uniqueKeys = 0;
	#records = 0;
	#highWaterBytes = 0;
	#copyHighWaterBytes = 0;
	#hits = 0;
	#misses = 0;
	#chainSteps = 0;
	#closed = false;

	constructor({
		pageSize = 64 * 1024,
		cacheBytes = 8 * 1024 * 1024,
		bucketCount = 64 * 1024,
		tempDirectory = nodeOs.tmpdir(),
		keyHash = defaultHash,
	}: PagedKeyValueStoreOptions = {}) {
		positiveSafeInteger(pageSize, 'pageSize');
		positiveSafeInteger(cacheBytes, 'cacheBytes');
		positiveSafeInteger(bucketCount, 'bucketCount');
		if (pageSize < PAGE_HEADER_BYTES + RECORD_HEADER_BYTES) {
			throw new PagedStoreError(
				'PAGED_STORE_INVALID_OPTIONS',
				`pageSize must be at least ${PAGE_HEADER_BYTES + RECORD_HEADER_BYTES} bytes.`);
		}
		if (cacheBytes < pageSize) {
			throw new PagedStoreError(
				'PAGED_STORE_INVALID_OPTIONS',
				`cacheBytes (${cacheBytes}) must be at least one page (${pageSize} bytes).`);
		}
		if (!Number.isSafeInteger(bucketCount * BUCKET_ENTRY_BYTES)) {
			throw new PagedStoreError(
				'PAGED_STORE_INVALID_OPTIONS',
				`bucketCount (${bucketCount}) requires an index file larger than JavaScript can address exactly.`);
		}

		this.pageSize = pageSize;
		this.cacheBudgetBytes = cacheBytes;
		this.bucketCount = bucketCount;
		this.#hash = keyHash;
		this.#bucketView = new DataView(this.#bucketScratch.buffer);
		// Creating the store is itself a write, and the first thing a full or
		// read-only temporary directory rejects — so it gets the same treatment
		// as any later one rather than surfacing as a bare errno.
		try {
			this.#directory = nodeFs.mkdtempSync(nodePath.join(tempDirectory, 'one2md-pages-'));
		}
		catch (error) {
			rethrowSpace(error, tempDirectory, 'temporary store directory');
		}

		this.backingFilePath = nodePath.join(this.#directory, 'store.pages');
		this.indexFilePath = nodePath.join(this.#directory, 'store.buckets');

		// Two files and a sizing call, any of which can fail on its own — the
		// second open on a descriptor limit, the truncate on a full disk. A
		// throw from here means no store is returned, so nothing will ever call
		// `close`, so whatever did open has to be undone here or it leaks a
		// descriptor and a directory for the life of the process.
		let pagesFd: number | undefined;
		let indexFd: number | undefined;

		try {
			pagesFd = nodeFs.openSync(this.backingFilePath, 'w+');
			indexFd = nodeFs.openSync(this.indexFilePath, 'w+');
			// Sized once, so an empty bucket reads as a zeroed — that is, nil — link.
			nodeFs.ftruncateSync(indexFd, bucketCount * BUCKET_ENTRY_BYTES);
		}
		catch (error) {
			closeQuietly(pagesFd);
			closeQuietly(indexFd);
			// Best effort, and deliberately not allowed to replace the real
			// failure: a directory left behind is a smaller problem than a
			// misleading message about why the store could not be made.
			try {
				nodeFs.rmSync(this.#directory, { recursive: true, force: true });
			}
			catch { /* the original failure is the one worth reporting */ }

			rethrowSpace(error, this.#directory, 'bucket table');
		}

		this.#pagesFd = pagesFd;
		this.#indexFd = indexFd;
	}

	/** The number of distinct keys held, counting an updated key once. */
	get size(): number {
		this.#ensureOpen();
		return this.#uniqueKeys;
	}

	get cacheStats(): PageCacheStats {
		return {
			budgetBytes: this.cacheBudgetBytes,
			residentBytes: this.#cache.size * this.pageSize,
			highWaterBytes: this.#highWaterBytes,
			pages: this.#cache.size,
			hits: this.#hits,
			misses: this.#misses,
			records: this.#records,
			chainSteps: this.#chainSteps,
			copyHighWaterBytes: this.#copyHighWaterBytes,
		};
	}

	has(key: Uint8Array): boolean {
		return this.#find(key) !== undefined;
	}

	/**
	 * The value for a key, as bytes the caller owns.
	 *
	 * A copy rather than a view into the cached page, and it has to be: the
	 * next lookup can evict that page, and a caller holding a view into an
	 * evicted page would be reading a buffer that is about to be overwritten
	 * by an unrelated page.
	 *
	 * That copy is an allocation the caller is charged for, and a record fits
	 * in a page by construction, so it is at most a page. `recordCopyBytes` in
	 * the budget reserves for the several that callers hold at once.
	 */
	get(key: Uint8Array): Uint8Array | undefined {
		const location = this.#find(key);
		if (!location) return undefined;
		const page = this.#loadPage(location.pageNumber);
		const valueOffset = location.offset + RECORD_HEADER_BYTES + location.keyLength;
		const copy = page.slice(valueOffset, valueOffset + location.valueLength);
		if (copy.byteLength > this.#copyHighWaterBytes) this.#copyHighWaterBytes = copy.byteLength;
		return copy;
	}

	/** The largest record any `get` has handed out, for the accounting. */
	get copyHighWaterBytes(): number {
		return this.#copyHighWaterBytes;
	}

	set(key: Uint8Array, value: Uint8Array): void {
		this.#ensureOpen();
		const recordLength = RECORD_HEADER_BYTES + key.byteLength + value.byteLength;
		const capacity = this.pageSize - PAGE_HEADER_BYTES;
		if (!Number.isSafeInteger(recordLength) || recordLength > capacity) {
			throw new PagedStoreError(
				'PAGED_STORE_RECORD_TOO_LARGE',
				`Key (${key.byteLength} bytes) and value (${value.byteLength} bytes) require ${recordLength} record bytes, but a ${this.pageSize}-byte page holds at most ${capacity}.`);
		}

		// The chain is walked before the page is touched, both to learn whether
		// this key is new and so that no cache eviction can happen between
		// mutating the destination page and writing it through.
		const bucket = this.#bucketOf(key);
		const head = this.#readBucketHead(bucket);
		const replaces = this.#findInChain(key, head) !== undefined;

		let page = this.#activePage < 0 ? this.#createPage() : this.#loadPage(this.#activePage);
		let view = new DataView(page.buffer, page.byteOffset, page.byteLength);
		let used = view.getUint32(0, true);
		if (used + recordLength > this.pageSize) {
			page = this.#createPage();
			view = new DataView(page.buffer, page.byteOffset, page.byteLength);
			used = PAGE_HEADER_BYTES;
		}
		const pageNumber = this.#activePage;

		view.setUint32(used, key.byteLength, true);
		view.setUint32(used + 4, value.byteLength, true);
		view.setUint32(used + 8, head % 0x100000000, true);
		view.setUint32(used + 12, Math.floor(head / 0x100000000), true);
		page.set(key, used + RECORD_HEADER_BYTES);
		page.set(value, used + RECORD_HEADER_BYTES + key.byteLength);
		view.setUint32(0, used + recordLength, true);
		view.setUint32(4, view.getUint32(4, true) + 1, true);
		writeAll(this.#pagesFd, page, pageNumber * this.pageSize, 'backing file', this.#directory);
		this.#putCached(pageNumber, page);

		this.#writeBucketHead(bucket, pageNumber * this.pageSize + used + 1);
		this.#records++;
		if (!replaces) this.#uniqueKeys++;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#cache.clear();
		nodeFs.closeSync(this.#pagesFd);
		nodeFs.closeSync(this.#indexFd);
		// Removes the pages and the bucket table together, along with the
		// private directory that only ever holds those two.
		nodeFs.rmSync(this.#directory, { recursive: true, force: true });
	}

	#find(key: Uint8Array): RecordLocation | undefined {
		this.#ensureOpen();
		return this.#findInChain(key, this.#readBucketHead(this.#bucketOf(key)));
	}

	/** Walks a bucket newest-first, confirming each candidate's key bytes. */
	#findInChain(key: Uint8Array, head: number): RecordLocation | undefined {
		let link = head;
		while (link !== NIL_LINK) {
			this.#chainSteps++;
			const record = this.#readRecord(link - 1);
			if (record.keyLength === key.byteLength) {
				const page = this.#loadPage(record.pageNumber);
				const stored = page.subarray(
					record.offset + RECORD_HEADER_BYTES,
					record.offset + RECORD_HEADER_BYTES + record.keyLength);
				if (bytesEqual(stored, key)) return record;
			}
			link = record.previous;
		}
		return undefined;
	}

	#readRecord(address: number): RecordLocation {
		const pageNumber = Math.floor(address / this.pageSize);
		const offset = address % this.pageSize;
		const page = this.#loadPage(pageNumber);
		const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
		const used = view.getUint32(0, true);

		if (offset < PAGE_HEADER_BYTES || offset + RECORD_HEADER_BYTES > used) {
			throw new PagedStoreError(
				'PAGED_STORE_CORRUPT_INDEX',
				`A chain link points at offset ${offset} of page ${pageNumber}, which holds ${used} used bytes.`);
		}

		const keyLength = view.getUint32(offset, true);
		const valueLength = view.getUint32(offset + 4, true);
		if (offset + RECORD_HEADER_BYTES + keyLength + valueLength > used) {
			throw new PagedStoreError(
				'PAGED_STORE_CORRUPT_INDEX',
				`A record at offset ${offset} of page ${pageNumber} claims ${keyLength} key and ${valueLength} value bytes, past the page's ${used} used bytes.`);
		}

		const previous = view.getUint32(offset + 12, true) * 0x100000000 + view.getUint32(offset + 8, true);
		if (!Number.isSafeInteger(previous)) {
			throw new PagedStoreError(
				'PAGED_STORE_CORRUPT_INDEX',
				`A record at offset ${offset} of page ${pageNumber} carries an unreadable chain link.`);
		}

		return { address, pageNumber, offset, keyLength, valueLength, previous };
	}

	#bucketOf(key: Uint8Array): number {
		const hash = this.#hash(key);
		if (!Number.isInteger(hash) || hash < 0 || hash > 0xffffffff) {
			throw new PagedStoreError(
				'PAGED_STORE_INVALID_HASH',
				`keyHash must return an integer in the uint32 range; received ${hash}.`);
		}
		return hash % this.bucketCount;
	}

	#readBucketHead(bucket: number): number {
		readAll(
			this.#indexFd,
			this.#bucketScratch,
			bucket * BUCKET_ENTRY_BYTES,
			'bucket table');
		const link = this.#bucketView.getUint32(4, true) * 0x100000000 + this.#bucketView.getUint32(0, true);
		if (!Number.isSafeInteger(link)) {
			throw new PagedStoreError(
				'PAGED_STORE_CORRUPT_INDEX',
				`Bucket ${bucket} holds an unreadable chain head.`);
		}
		return link;
	}

	#writeBucketHead(bucket: number, link: number): void {
		this.#bucketView.setUint32(0, link % 0x100000000, true);
		this.#bucketView.setUint32(4, Math.floor(link / 0x100000000), true);
		writeAll(
			this.#indexFd,
			this.#bucketScratch,
			bucket * BUCKET_ENTRY_BYTES,
			'bucket table', this.#directory);
	}

	#createPage(): Uint8Array {
		const pageNumber = this.#pageCount++;
		const offset = pageNumber * this.pageSize;
		if (!Number.isSafeInteger(offset + this.pageSize)) {
			throw new PagedStoreError(
				'PAGED_STORE_SIZE_LIMIT',
				`Backing file would exceed JavaScript's safe positional I/O range at page ${pageNumber}.`);
		}
		this.#makeRoom();

		const page = new Uint8Array(this.pageSize);
		const view = new DataView(page.buffer);
		view.setUint32(0, PAGE_HEADER_BYTES, true);
		writeAll(this.#pagesFd, page, offset, 'backing file', this.#directory);
		this.#activePage = pageNumber;
		this.#putCached(pageNumber, page);
		return page;
	}

	#loadPage(pageNumber: number): Uint8Array {
		const cached = this.#cache.get(pageNumber);
		if (cached) {
			this.#hits++;
			this.#cache.delete(pageNumber);
			this.#cache.set(pageNumber, cached);
			return cached;
		}

		this.#misses++;
		if (pageNumber < 0 || pageNumber >= this.#pageCount) {
			throw new PagedStoreError(
				'PAGED_STORE_CORRUPT_INDEX',
				`Page ${pageNumber} is outside the ${this.#pageCount} pages written so far.`);
		}

		// Room first, then the page. Allocating into a full cache and evicting
		// afterwards put one page over the budget for as long as the read
		// took — small, but a ceiling that is exceeded on every miss is not a
		// ceiling. There is nothing to lose by evicting first: the page being
		// replaced is on disk already.
		this.#makeRoom();

		const page = new Uint8Array(this.pageSize);
		readAll(this.#pagesFd, page, pageNumber * this.pageSize, 'backing file');
		const used = new DataView(page.buffer).getUint32(0, true);
		if (used < PAGE_HEADER_BYTES || used > this.pageSize) {
			throw new PagedStoreError(
				'PAGED_STORE_CORRUPT_PAGE',
				`Page ${pageNumber} reports ${used} used bytes, outside its ${this.pageSize}-byte bounds.`);
		}
		this.#putCached(pageNumber, page);
		return page;
	}

	/**
	 * Evict until one more page would still fit.
	 *
	 * Called before a page is allocated rather than after, so the cache is
	 * never momentarily a page over its budget. The two are otherwise the same
	 * eviction — least recently used first, which is what `Map` iteration order
	 * gives once `#loadPage` moves a hit to the end.
	 */
	#makeRoom(): void {
		while ((this.#cache.size + 1) * this.pageSize > this.cacheBudgetBytes) {
			const oldest = this.#cache.keys().next().value as number | undefined;
			if (oldest === undefined) return;
			this.#cache.delete(oldest);
		}
	}

	#putCached(pageNumber: number, page: Uint8Array): void {
		this.#cache.delete(pageNumber);
		this.#makeRoom();
		this.#cache.set(pageNumber, page);
		this.#highWaterBytes = Math.max(this.#highWaterBytes, this.#cache.size * this.pageSize);
	}

	#ensureOpen(): void {
		if (this.#closed) {
			throw new PagedStoreError('PAGED_STORE_CLOSED', 'The paged key/value store is closed.');
		}
	}
}
