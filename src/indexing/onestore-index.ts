/**
 * Indexing a desktop MS-ONESTORE section without building it.
 *
 * `readRevisionStore` makes three passes and keeps the result of each: every
 * file-node list is read into a `FileNode[]`, the lists are linked into a tree,
 * and the tree is walked into an `ObjectGraph` holding a decoded property set
 * per object. All three are proportional to the section, and the third is the
 * expensive one.
 *
 * This does the same walk in one pass and keeps none of it. Fragments are
 * followed through a sliding window; a file node is read, dispatched and
 * dropped; and what survives is a fixed-size descriptor written to the on-disk
 * index. The heap holds counters, one file-node body at a time (8 KiB at
 * most, since a node's size field is thirteen bits), and a stack of frames one
 * deep per nested file-node list — never anything that grows with the number of
 * nodes, objects, revisions or global identifiers.
 *
 * The structural checks are the ones `readTransactionLog`, `readFileNodeList`
 * and `readObjectGraph` make, in the same order and with the same error codes,
 * because the point of a second reader is not to be more forgiving than the
 * first. What it does not do is decode property sets: an object's bytes are
 * recorded as a range, and the next stage reads them when it needs them.
 *
 * Field layouts and validation follow the vendored obsidian-importer reader,
 * which in turn follows OfficeIMO; see NOTICE.md. Those files are checked
 * verbatim against upstream, so the small amount that has to work one field at
 * a time from a window is restated here rather than exported from them.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import {
	EMPTY_GUID,
	FileChunkReference,
	isAllOnes,
	readGuid,
	readUInt16,
	readUInt32,
	readUInt64,
	readUnsigned,
} from '../onenote-file/onestore/binary';
import {
	FILE_NODE_LIST_FOOTER_MAGIC,
	FILE_NODE_LIST_HEADER_MAGIC,
	FileKind,
	FileNodeBaseType,
	FileNodeId,
} from '../onenote-file/onestore/constants';
import { FileHeader } from '../onenote-file/onestore/file-header';
import { ByteRange } from '../storage/byte-source';
import { ByteWindow } from '../storage/byte-window';
import { RecordWriter } from '../storage/records';
import {
	IndexedGuid,
	IndexedSection,
	INDEXER_TAG_BASE,
	SectionIndex,
	SectionIndexOptions,
} from './section-index';

const FRAGMENT_HEADER_LENGTH = 16;
const FRAGMENT_TRAILER_LENGTH = 20;
const TRANSACTION_ENTRY_LENGTH = 8;
const NEXT_FRAGMENT_LENGTH = 12;

const FILE_DATA_HEADER = 'bde316e7-2665-4511-a4c4-8d4d0b7a9eac';
const FILE_DATA_FOOTER = '71fba722-0f79-4a0b-bb13-899256426b24';

const ONE_POLYNOMIAL = 0xedb88320;
const MSO_POLYNOMIAL = 0x000000af;

const BASE_TYPES: FileNodeBaseType[] = ['inline', 'data-reference', 'file-node-list-reference'];

/**
 * How deep referenced file-node lists may nest.
 *
 * The frame stack is the one structure here that grows with the file, and it
 * grows with nesting depth rather than with node count: a real section nests a
 * handful deep. A cap keeps a hostile file from turning that into unbounded
 * heap, and is far above anything OneNote writes.
 */
const MAX_LIST_NESTING = 1024;

const NO_REVISION = -1;
const EMPTY_VALUE = new Uint8Array(0);

/** Namespaces this indexer's own bookkeeping inside the shared paged store. */
const Tag = {
	transactionCount: INDEXER_TAG_BASE,
	transactionFragment: INDEXER_TAG_BASE + 1,
	visitedList: INDEXER_TAG_BASE + 2,
	listFragment: INDEXER_TAG_BASE + 3,
	knownJcid: INDEXER_TAG_BASE + 4,
} as const;

interface IndexedFileNode {
	id: number;
	baseType: FileNodeBaseType;
	fileOffset: number;
	chunkReference?: FileNodeChunk;
	/** The node's own body, at most 8,187 bytes. Owned, and short-lived. */
	data: Uint8Array;
}

interface FileNodeChunk {
	offset: number;
	length: number;
	isNil: boolean;
	encodedLength: number;
}

interface ListFrame {
	nodes: Iterator<IndexedFileNode>;
	/** Which global-identification scope this list's CompactIDs resolve in. */
	scope: number;
	revisionOrder: number;
	objectSpaceId?: IndexedGuid;
}

/** [MS-ONESTORE] 2.6.5 — the CRC a committed transaction's sentinel carries. */
function continueCrc(crc: number, data: Uint8Array, count: number, fileKind: FileKind): number {
	if (fileKind === 'section') {
		let state = ~crc >>> 0;
		for (let index = 0; index < count; index++) {
			state = (state ^ data[index]) >>> 0;
			for (let bit = 0; bit < 8; bit++) state = ((state >>> 1) ^ ((state & 1) !== 0 ? ONE_POLYNOMIAL : 0)) >>> 0;
		}
		return ~state >>> 0;
	}

	let state = crc >>> 0;
	for (let index = 0; index < count; index++) {
		state = (state ^ (data[index] << 24)) >>> 0;
		for (let bit = 0; bit < 8; bit++) state = (((state << 1) >>> 0) ^ ((state & 0x80000000) !== 0 ? MSO_POLYNOMIAL : 0)) >>> 0;
	}
	return state;
}

function bytesMatch(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
	for (let index = 0; index < expected.length; index++) {
		if (data[offset + index] !== expected[index]) return false;
	}
	return true;
}

function readExtendedGuidAt(data: Uint8Array, offset: number): IndexedGuid {
	return { identifier: readGuid(data, offset), value: readUInt32(data, offset + 16) };
}

function isEmptyGuid(id: IndexedGuid): boolean {
	return id.identifier === EMPTY_GUID && id.value === 0;
}

function guidKey(id: IndexedGuid): string {
	return `${id.identifier}:${id.value}`;
}

function readByte(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset >= data.length) {
		throw new OneNoteFormatError(
			'ONENOTE_TRUNCATED_STRUCTURE',
			'The OneNote file ended before a required structure could be read.',
			offset);
	}
	return data[offset];
}

function readStorageString(data: Uint8Array, position: number, absoluteOffset: number): { value: string, next: number } {
	const characterCount = readUInt32(data, position);
	position += 4;

	if (characterCount > 0x3fffffff || position > data.length - characterCount * 2) {
		throw new OneNoteFormatError(
			'ONENOTE_STORAGE_STRING',
			'A StringInStorageBuffer length exceeds its containing structure.',
			absoluteOffset + position - 4);
	}

	return {
		value: new TextDecoder('utf-16le').decode(data.subarray(position, position + characterCount * 2)),
		next: position + characterCount * 2,
	};
}

function multiplyByEight(value: number, offset: number): number {
	if (value > Number.MAX_SAFE_INTEGER / 8) {
		throw new OneNoteFormatError(
			'ONENOTE_COMPRESSED_REFERENCE_OVERFLOW',
			'A compressed chunk reference overflows its decoded range.',
			offset);
	}
	return value * 8;
}

/** [MS-ONESTORE] 2.2.4 — a file node's chunk reference, in its four widths. */
function readChunkReference(data: Uint8Array, stpFormat: number, cbFormat: number, absoluteOffset: number): FileNodeChunk {
	const stpBytes = stpFormat === 0 ? 8 : stpFormat === 2 ? 2 : 4;
	const cbBytes = cbFormat === 0 ? 4 : cbFormat === 1 ? 8 : cbFormat === 2 ? 1 : 2;
	const encodedLength = stpBytes + cbBytes;

	if (isAllOnes(data, 0, stpBytes) && readUnsigned(data, stpBytes, cbBytes) === 0) {
		return { offset: 0, length: 0, isNil: true, encodedLength };
	}

	const rawOffset = readUnsigned(data, 0, stpBytes);
	const rawLength = readUnsigned(data, stpBytes, cbBytes);

	return {
		offset: stpFormat >= 2 ? multiplyByEight(rawOffset, absoluteOffset) : rawOffset,
		length: cbFormat >= 2 ? multiplyByEight(rawLength, absoluteOffset + stpBytes) : rawLength,
		isNil: false,
		encodedLength,
	};
}

function isRealChunk(chunk: FileNodeChunk | undefined): chunk is FileNodeChunk {
	return chunk !== undefined && !chunk.isNil && !(chunk.offset === 0 && chunk.length === 0);
}

class RevisionStoreIndexer {
	readonly #index: IndexedSection;
	readonly #window: ByteWindow;
	readonly #header: FileHeader;
	readonly #declaredFileLength: number;

	readonly #key = new RecordWriter(48);
	readonly #value = new RecordWriter(48);

	#totalNodes = 0;
	#fragmentScopes = 0;
	#nextRoleAssociationOrder = 0;
	#totalAssetBytes = 0;

	constructor(index: IndexedSection) {
		this.#index = index;
		this.#window = index.window;
		this.#header = index.header;
		this.#declaredFileLength = index.header.expectedFileLength!;
	}

	run(): void {
		this.#indexTransactionLog();

		const root = this.#header.rootFileNodeList!;
		this.#validateRootList(root);

		this.#markVisitedList(root.offset);
		const frames: ListFrame[] = [{
			nodes: this.#fileNodes(root),
			scope: this.#index.openGlobalIdScope(),
			revisionOrder: NO_REVISION,
		}];

		while (frames.length > 0) {
			const frame = frames[frames.length - 1];
			const next = frame.nodes.next();

			if (next.done) {
				frames.pop();
				continue;
			}

			const node = next.value;
			if (++this.#totalNodes > this.#index.options.maxFileNodes) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_LIMIT', 'The file-node limit was exceeded.', node.fileOffset);
			}

			this.#processNode(node, frame);

			if (node.baseType !== 'file-node-list-reference' || !isRealChunk(node.chunkReference)) continue;
			if (this.#visitedList(node.chunkReference.offset)) continue;
			this.#markVisitedList(node.chunkReference.offset);

			if (frames.length >= MAX_LIST_NESTING) {
				throw new OneNoteFormatError(
					'ONENOTE_FILE_NODE_LIST_DEPTH',
					`Referenced file-node lists nest deeper than the ${MAX_LIST_NESTING} levels this reader will follow.`,
					node.fileOffset);
			}

			// An object group list continues the revision that referenced it;
			// anything else starts a list with no revision in scope.
			const inherited = node.id === FileNodeId.objectGroupListReference ? frame.revisionOrder : NO_REVISION;
			frames.push({
				nodes: this.#fileNodes({
					offset: node.chunkReference.offset,
					length: node.chunkReference.length,
					isNil: false,
				}),
				scope: this.#index.openGlobalIdScope(),
				revisionOrder: inherited,
				objectSpaceId: inherited === NO_REVISION ? undefined : this.#index.revisionAt(inherited).objectSpaceId,
			});
		}
	}

	// -- Transaction log ----------------------------------------------------

	/**
	 * The committed node count for each file-node list, accumulated on disk.
	 *
	 * The log is append-only and a list's count only ever rises, so the last
	 * entry for a list wins. There can be one entry per list per transaction,
	 * which is why neither the counts nor the fragments already visited can be
	 * a heap map.
	 */
	#indexTransactionLog(): void {
		const { transactionLog, transactionCount, fileKind } = this.#header;
		const options = this.#index.options;

		if (!transactionLog || transactionCount === undefined) {
			throw new OneNoteFormatError(
				'ONENOTE_TRANSACTION_LOG_HEADER',
				'The revision-store header does not expose a complete transaction log reference.');
		}

		let current: FileChunkReference = transactionLog;
		let completedTransactions = 0;
		let fragmentCount = 0;
		let entryCount = 0;
		let runningCrc = 0;
		let listCount = 0;

		while (completedTransactions < transactionCount) {
			if (current.isNil
				|| (current.offset === 0 && current.length === 0)
				|| current.length < TRANSACTION_ENTRY_LENGTH + NEXT_FRAGMENT_LENGTH) {
				throw new OneNoteFormatError(
					'ONENOTE_TRANSACTION_LOG_TRUNCATED',
					'The transaction log ended before all committed transactions were found.',
					current.offset);
			}
			if (++fragmentCount > options.maxTransactionLogFragments) {
				throw new OneNoteFormatError('ONENOTE_TRANSACTION_FRAGMENT_LIMIT', 'The transaction-log fragment limit was exceeded.', current.offset);
			}
			if (this.#seen(Tag.transactionFragment, 0, current.offset)) {
				throw new OneNoteFormatError('ONENOTE_TRANSACTION_FRAGMENT_CYCLE', 'The transaction-log fragment chain contains a cycle.', current.offset);
			}
			this.#mark(Tag.transactionFragment, 0, current.offset);

			if (current.offset > this.#declaredFileLength || current.length > this.#declaredFileLength - current.offset) {
				throw new OneNoteFormatError('ONENOTE_TRANSACTION_FRAGMENT_BOUNDS', 'A transaction-log fragment lies outside the declared file length.', current.offset);
			}
			if (current.offset + current.length > this.#window.size) {
				throw new OneNoteFormatError('ONENOTE_TRANSACTION_FRAGMENT_TRUNCATED', 'The file ended while reading a transaction-log fragment.', current.offset);
			}

			const entryBytes = Math.floor((current.length - NEXT_FRAGMENT_LENGTH) / TRANSACTION_ENTRY_LENGTH) * TRANSACTION_ENTRY_LENGTH;
			let offset = 0;

			while (offset < entryBytes && completedTransactions < transactionCount) {
				if (++entryCount > options.maxTransactionEntries) {
					throw new OneNoteFormatError('ONENOTE_TRANSACTION_ENTRY_LIMIT', 'The transaction-entry limit was exceeded.', current.offset + offset);
				}

				// The window's bytes survive only until it moves, and the store
				// lookups below never touch it — but the checksum is folded in
				// first regardless, so the ordering cannot rot into a bug.
				const entry = this.#window.peek(current.offset + offset, TRANSACTION_ENTRY_LENGTH);
				const sourceId = readUInt32(entry, 0);
				const value = readUInt32(entry, 4);
				const nextCrc = continueCrc(runningCrc, entry, TRANSACTION_ENTRY_LENGTH, fileKind);

				if (sourceId === 1) {
					if (options.validateTransactionChecksums && value !== runningCrc) {
						throw new OneNoteFormatError('ONENOTE_TRANSACTION_CHECKSUM', 'A committed transaction has an invalid sentinel checksum.', current.offset + offset + 4);
					}
					completedTransactions++;
				}
				else {
					if (sourceId < 0x10) {
						throw new OneNoteFormatError('ONENOTE_TRANSACTION_SOURCE_ID', 'A transaction entry contains an invalid file-node-list identity.', current.offset + offset);
					}
					if (value > options.maxFileNodes) {
						throw new OneNoteFormatError('ONENOTE_TRANSACTION_FILE_NODE_COUNT', 'A transaction entry contains an invalid file-node count.', current.offset + offset + 4);
					}

					const previous = this.#committedNodeCount(sourceId);
					if (previous !== undefined && value <= previous) {
						throw new OneNoteFormatError('ONENOTE_TRANSACTION_FILE_NODE_SEQUENCE', 'A transaction entry does not increase its file-node-list count.', current.offset + offset + 4);
					}
					if (previous === undefined) listCount++;

					this.#index.store.set(
						this.#key.reset(Tag.transactionCount).u32(sourceId).done(),
						this.#value.reset().u32(value).done());
				}

				runningCrc = nextCrc;
				offset += TRANSACTION_ENTRY_LENGTH;
			}

			if (completedTransactions >= transactionCount) break;
			current = readNextFragment(this.#window.peek(current.offset + entryBytes, NEXT_FRAGMENT_LENGTH));
		}

		if (listCount === 0) {
			throw new OneNoteFormatError('ONENOTE_TRANSACTION_LOG_EMPTY', 'The committed transaction log declares no file-node lists.');
		}
	}

	#committedNodeCount(listId: number): number | undefined {
		const stored = this.#index.store.get(this.#key.reset(Tag.transactionCount).u32(listId).done());
		return stored ? readUInt32(stored, 0) : undefined;
	}

	// -- File-node lists ----------------------------------------------------

	/**
	 * Every committed node of one file-node list, in order, one at a time.
	 *
	 * The generator is what makes the walk incremental: the caller can descend
	 * into a referenced list and come back, and this resumes mid-fragment
	 * without the parent's remaining nodes ever having been materialized. The
	 * list-wide checks that `readFileNodeList` makes on a finished array — the
	 * committed count, an empty chain — run when the generator finishes, so
	 * they still fire, but only for a list that was walked to its end.
	 */
	*#fileNodes(first: FileChunkReference): Generator<IndexedFileNode> {
		const options = this.#index.options;
		const scope = this.#fragmentScopes++;

		let current = first;
		let listId: number | undefined;
		let committedNodeCount = 0;
		let produced = 0;
		let expectedSequence = 0;
		let fragmentCount = 0;

		while (!current.isNil) {
			if ((current.offset === 0 && current.length === 0)
				|| current.length < FRAGMENT_HEADER_LENGTH + FRAGMENT_TRAILER_LENGTH) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_FRAGMENT_REFERENCE', 'A file-node-list fragment reference is empty or too short.', current.offset);
			}
			if (fragmentCount >= options.maxFileNodeListFragments) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_FRAGMENT_LIMIT', 'The file-node-list fragment limit was exceeded.', current.offset);
			}
			if (this.#seen(Tag.listFragment, scope, current.offset)) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_FRAGMENT_CYCLE', 'The file-node-list fragment chain contains a cycle.', current.offset);
			}
			this.#mark(Tag.listFragment, scope, current.offset);

			if (current.offset > this.#declaredFileLength || current.length > this.#declaredFileLength - current.offset) {
				throw new OneNoteFormatError('ONENOTE_CHUNK_REFERENCE_BOUNDS', 'The file-node-list fragment lies outside the declared file length.', current.offset);
			}
			if (current.offset + current.length > this.#window.size) {
				throw new OneNoteFormatError('ONENOTE_TRUNCATED_STRUCTURE', 'The OneNote file ended while reading a referenced structure.', current.offset);
			}

			const head = this.#window.peek(current.offset, FRAGMENT_HEADER_LENGTH);
			if (!bytesMatch(head, 0, FILE_NODE_LIST_HEADER_MAGIC)) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_HEADER_MAGIC', 'The file-node-list fragment header magic is invalid.', current.offset);
			}

			const currentListId = readUInt32(head, 8);
			const sequence = readUInt32(head, 12);

			if (currentListId < 0x10) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_LIST_ID', 'The file-node-list identity is below the minimum valid value.', current.offset + 8);
			}
			if (listId !== undefined && listId !== currentListId) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_LIST_MISMATCH', 'A fragment belongs to a different file-node list.', current.offset + 8);
			}
			if (listId === undefined) {
				const count = this.#committedNodeCount(currentListId);
				if (count === undefined) {
					throw new OneNoteFormatError('ONENOTE_TRANSACTION_FILE_NODE_LIST', 'The transaction log does not declare the referenced file-node list.', current.offset + 8);
				}
				if (count < 1 || count > options.maxFileNodes) {
					throw new OneNoteFormatError('ONENOTE_TRANSACTION_FILE_NODE_COUNT', 'The transaction log declares an invalid file-node count.', current.offset + 8);
				}
				committedNodeCount = count;
			}
			if (sequence !== expectedSequence) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_SEQUENCE', 'The file-node-list fragment sequence is not contiguous.', current.offset + 12);
			}

			const trailerOffset = current.offset + current.length - FRAGMENT_TRAILER_LENGTH;
			const trailer = this.#window.read(trailerOffset, FRAGMENT_TRAILER_LENGTH);
			if (!bytesMatch(trailer, FRAGMENT_TRAILER_LENGTH - 8, FILE_NODE_LIST_FOOTER_MAGIC)) {
				throw new OneNoteFormatError('ONENOTE_FILE_NODE_FOOTER_MAGIC', 'The file-node-list fragment footer magic is invalid.', current.offset + current.length - 8);
			}

			listId = currentListId;
			fragmentCount++;

			const remaining = committedNodeCount - produced;
			if (remaining <= 0) break;

			let offset = current.offset + FRAGMENT_HEADER_LENGTH;
			let fromFragment = 0;

			while (trailerOffset - offset >= 4 && fromFragment < remaining) {
				if (produced >= options.maxFileNodes) {
					throw new OneNoteFormatError('ONENOTE_FILE_NODE_LIMIT', 'The file-node limit was exceeded.', offset);
				}

				const header = readUInt32(this.#window.peek(offset, 4), 0);
				const id = header & 0x3ff;
				if (id === 0) break;

				const size = (header >>> 10) & 0x1fff;
				const stpFormat = (header >>> 23) & 0x03;
				const cbFormat = (header >>> 25) & 0x03;
				const rawBaseType = (header >>> 27) & 0x0f;

				if ((header & 0x80000000) === 0) {
					throw new OneNoteFormatError('ONENOTE_FILE_NODE_RESERVED_BIT', 'The required file-node reserved bit is not set.', offset);
				}
				if (size < 4 || size > trailerOffset - offset) {
					throw new OneNoteFormatError('ONENOTE_FILE_NODE_SIZE', 'The file-node size is invalid or crosses the fragment trailer.', offset);
				}
				if (rawBaseType > 2) {
					throw new OneNoteFormatError('ONENOTE_FILE_NODE_BASE_TYPE', 'The file-node base type is invalid.', offset);
				}

				const baseType = BASE_TYPES[rawBaseType];
				const data = this.#window.read(offset + 4, size - 4);
				let chunkReference: FileNodeChunk | undefined;

				if (baseType !== 'inline') {
					chunkReference = readChunkReference(data, stpFormat, cbFormat, offset + 4);
					if (isRealChunk(chunkReference)
						&& (chunkReference.offset > this.#declaredFileLength
							|| chunkReference.length > this.#declaredFileLength - chunkReference.offset)) {
						throw new OneNoteFormatError('ONENOTE_CHUNK_REFERENCE_BOUNDS', 'The file-node chunk reference lies outside the declared file length.', chunkReference.offset);
					}
				}
				else if (cbFormat !== 0) {
					throw new OneNoteFormatError('ONENOTE_INLINE_CB_FORMAT', 'An inline file node has a nonzero byte-count format.', offset);
				}

				yield { id, baseType, fileOffset: offset, chunkReference, data };

				produced++;
				fromFragment++;
				offset += size;
				if (id === FileNodeId.chunkTerminator) break;
			}

			current = readNextFragment(trailer);
			expectedSequence++;
			if (produced === committedNodeCount) break;
		}

		if (listId === undefined) {
			throw new OneNoteFormatError('ONENOTE_FILE_NODE_LIST_EMPTY', 'The file-node list contains no fragments.');
		}
		if (produced !== committedNodeCount) {
			throw new OneNoteFormatError('ONENOTE_FILE_NODE_COUNT', 'The file-node list ended before its committed transaction-log count was reached.', first.offset);
		}
	}

	/**
	 * The root list may hold only object-space references and one root
	 * declaration, which is checked before anything descends into it. The nodes
	 * are read a second time by the walk proper; the list is a handful of nodes,
	 * and reading it twice is cheaper than keeping it.
	 */
	#validateRootList(root: FileChunkReference): void {
		let manifestReferences = 0;
		let rootDeclarations = 0;
		let disallowedAt: number | undefined;

		for (const node of this.#fileNodes(root)) {
			if (node.id === FileNodeId.objectSpaceManifestListReference) manifestReferences++;
			if (node.id === FileNodeId.objectSpaceManifestRoot) rootDeclarations++;

			const allowed = node.id === FileNodeId.objectSpaceManifestListReference
				|| node.id === FileNodeId.objectSpaceManifestRoot
				|| node.id === FileNodeId.chunkTerminator
				|| (this.#header.fileKind === 'section' && node.id === FileNodeId.fileDataStoreListReference);

			if (!allowed && disallowedAt === undefined) disallowedAt = node.fileOffset;
		}

		if (manifestReferences < 1 || rootDeclarations !== 1) {
			throw new OneNoteFormatError(
				'ONENOTE_ROOT_FILE_NODE_LIST',
				'The root file-node list does not contain the required object-space references and single root declaration.');
		}
		if (disallowedAt !== undefined) {
			throw new OneNoteFormatError(
				'ONENOTE_ROOT_FILE_NODE_TYPE',
				'The root file-node list contains a file-node type that is not valid at the root.',
				disallowedAt);
		}
	}

	// -- Node dispatch ------------------------------------------------------

	#processNode(node: IndexedFileNode, frame: ListFrame): void {
		switch (node.id) {
			case FileNodeId.revisionManifestListStart:
				frame.objectSpaceId = readExtendedGuidAt(node.data, 0);
				break;

			case FileNodeId.revisionManifestStart4:
			case FileNodeId.revisionManifestStart6:
			case FileNodeId.revisionManifestStart7:
				frame.revisionOrder = this.#readRevisionManifest(node, frame);
				break;

			case FileNodeId.revisionRoleDeclaration:
				this.#readRoleDeclaration(node, frame, false);
				break;
			case FileNodeId.revisionRoleAndContextDeclaration:
				this.#readRoleDeclaration(node, frame, true);
				break;

			case FileNodeId.globalIdTableStart:
			case FileNodeId.globalIdTableStart2:
				// A cleared table cannot forget what an already-indexed object
				// resolved against, so clearing opens a scope rather than
				// deleting entries.
				frame.scope = this.#index.openGlobalIdScope();
				break;
			case FileNodeId.globalIdTableEntry:
				this.#readGlobalIdEntry(node, frame.scope);
				break;

			case FileNodeId.rootObjectReference2:
			case FileNodeId.rootObjectReference3:
				if (frame.revisionOrder !== NO_REVISION) this.#readRootReference(node, frame);
				break;

			case FileNodeId.objectDeclarationWithRefCount:
			case FileNodeId.objectDeclarationWithRefCount2:
			case FileNodeId.objectDeclaration2RefCount:
			case FileNodeId.objectDeclaration2LargeRefCount:
			case FileNodeId.readOnlyObjectDeclaration2RefCount:
			case FileNodeId.readOnlyObjectDeclaration2LargeRefCount:
			case FileNodeId.objectRevisionWithRefCount:
			case FileNodeId.objectRevisionWithRefCount2:
				this.#readObject(node, frame);
				break;

			case FileNodeId.objectDeclarationFileData3RefCount:
			case FileNodeId.objectDeclarationFileData3LargeRefCount:
				this.#readFileDataDeclaration(node, frame);
				break;

			case FileNodeId.fileDataStoreObjectReference:
				this.#readFileDataStoreObject(node);
				break;
		}
	}

	#readRevisionManifest(node: IndexedFileNode, frame: ListFrame): number {
		const id = readExtendedGuidAt(node.data, 0);
		const dependency = readExtendedGuidAt(node.data, 20);
		const roleOffset = node.id === FileNodeId.revisionManifestStart4 ? 48 : 40;
		const role = readUInt32(node.data, roleOffset);
		const isEncrypted = readUInt16(node.data, roleOffset + 4) !== 0;
		const contextId = node.id === FileNodeId.revisionManifestStart7
			? readExtendedGuidAt(node.data, 46)
			: undefined;

		if (this.#index.hasRevision(id)) {
			throw new OneNoteFormatError('ONENOTE_REVISION_ID', 'A revision manifest identifier is duplicated.', node.fileOffset);
		}

		const order = this.#index.addRevision({
			id,
			dependencyId: isEmptyGuid(dependency) ? undefined : dependency,
			role,
			isEncrypted,
			contextId,
			objectSpaceId: frame.objectSpaceId,
		});

		this.#index.addRoleAssociation(order, { contextId, role, order: this.#nextRoleAssociationOrder++ });
		return order;
	}

	#readRoleDeclaration(node: IndexedFileNode, frame: ListFrame, includesContext: boolean): void {
		const revisionId = readExtendedGuidAt(node.data, 0);
		const role = readUInt32(node.data, 20);

		if (role > 0xffff) {
			throw new OneNoteFormatError('ONENOTE_REVISION_ROLE', 'A revision-role label has nonzero reserved high bytes.', node.fileOffset + 20);
		}

		const revision = this.#index.revision(revisionId);
		if (!revision
			|| !frame.objectSpaceId
			|| !revision.objectSpaceId
			|| guidKey(frame.objectSpaceId) !== guidKey(revision.objectSpaceId)) {
			throw new OneNoteFormatError(
				'ONENOTE_REVISION_ROLE_TARGET',
				'A revision-role declaration does not reference a preceding revision in the current object space.',
				node.fileOffset);
		}

		let contextId: IndexedGuid | undefined;
		if (includesContext) {
			const context = readExtendedGuidAt(node.data, 24);
			if (!isEmptyGuid(context)) contextId = context;
		}

		this.#index.addRoleAssociation(revision.order, { contextId, role, order: this.#nextRoleAssociationOrder++ });
	}

	#readGlobalIdEntry(node: IndexedFileNode, scope: number): void {
		const index = readUInt32(node.data, 0);

		if (index >= 0xffffff || this.#index.hasGlobalId(scope, index)) {
			throw new OneNoteFormatError('ONENOTE_GLOBAL_ID_INDEX', 'A global-identification table index is invalid or duplicated.', node.fileOffset);
		}

		const identifier = readGuid(node.data, 4);
		if (identifier === EMPTY_GUID) {
			throw new OneNoteFormatError('ONENOTE_GLOBAL_ID_GUID', 'A global-identification table contains an empty GUID.', node.fileOffset + 4);
		}

		this.#index.addGlobalId(scope, index, identifier);
	}

	#resolveCompactId(data: Uint8Array, offset: number, scope: number, absoluteOffset: number): IndexedGuid {
		const compact = readUInt32(data, offset);
		const identifier = this.#index.globalId(scope, compact >>> 8);

		if (identifier === undefined) {
			throw new OneNoteFormatError('ONENOTE_COMPACT_ID', 'A CompactID references a missing global-identification table entry.', absoluteOffset);
		}

		return { identifier, value: compact & 0xff };
	}

	#readRootReference(node: IndexedFileNode, frame: ListFrame): void {
		const isExtended = node.id === FileNodeId.rootObjectReference3;
		const objectId = isExtended
			? readExtendedGuidAt(node.data, 0)
			: this.#resolveCompactId(node.data, 0, frame.scope, node.fileOffset);

		this.#index.addRootObject(frame.revisionOrder, {
			objectId,
			role: readUInt32(node.data, isExtended ? 20 : 4),
		});
	}

	#readObject(node: IndexedFileNode, frame: ListFrame): void {
		if (this.#index.objectCount >= this.#index.options.maxObjects) {
			throw new OneNoteFormatError('ONENOTE_OBJECT_LIMIT', 'The object declaration limit was exceeded.', node.fileOffset);
		}
		if (!isRealChunk(node.chunkReference)) {
			throw new OneNoteFormatError('ONENOTE_OBJECT_REFERENCE', 'An object declaration does not reference object data.', node.fileOffset);
		}

		const bodyOffset = node.chunkReference.encodedLength;
		const id = this.#resolveCompactId(node.data, bodyOffset, frame.scope, node.fileOffset + bodyOffset);
		const isRevision = node.id === FileNodeId.objectRevisionWithRefCount
			|| node.id === FileNodeId.objectRevisionWithRefCount2;

		let jcid: number;
		let referenceCount: number;

		if (node.id === FileNodeId.objectDeclarationWithRefCount || node.id === FileNodeId.objectDeclarationWithRefCount2) {
			jcid = 0x00020001;
			const countOffset = bodyOffset + 10;
			referenceCount = node.id === FileNodeId.objectDeclarationWithRefCount
				? readByte(node.data, countOffset)
				: readUInt32(node.data, countOffset);
		}
		else if (isRevision) {
			// A revised object does not restate its type; it keeps the one its
			// original declaration gave it.
			jcid = this.#knownJcid(id) ?? 0;
			const flagsOffset = bodyOffset + 4;
			referenceCount = node.id === FileNodeId.objectRevisionWithRefCount
				? readByte(node.data, flagsOffset) >> 2
				: readUInt32(node.data, flagsOffset + 4);
		}
		else {
			jcid = readUInt32(node.data, bodyOffset + 4);
			const countOffset = bodyOffset + 9;
			const large = node.id === FileNodeId.objectDeclaration2LargeRefCount
				|| node.id === FileNodeId.readOnlyObjectDeclaration2LargeRefCount;
			referenceCount = large ? readUInt32(node.data, countOffset) : readByte(node.data, countOffset);
		}

		const revision = frame.revisionOrder === NO_REVISION ? undefined : this.#index.revisionAt(frame.revisionOrder);
		const propertySet = revision?.isEncrypted
			? undefined
			: this.#referencedRange(node.chunkReference, 0, node.chunkReference.length, 'object property set');

		this.#index.addObject({
			id,
			jcid,
			referenceCount,
			revisionOrder: frame.revisionOrder,
			revisionId: revision?.id,
			isRevision,
			propertySet,
			globalIdScope: frame.scope,
		});

		if (jcid !== 0) {
			this.#index.store.set(
				this.#key.reset(Tag.knownJcid).extendedGuid(id).done(),
				this.#value.reset().u32(jcid).done());
		}
	}

	#knownJcid(id: IndexedGuid): number | undefined {
		const stored = this.#index.store.get(this.#key.reset(Tag.knownJcid).extendedGuid(id).done());
		return stored ? readUInt32(stored, 0) : undefined;
	}

	#readFileDataDeclaration(node: IndexedFileNode, frame: ListFrame): void {
		if (this.#index.objectCount >= this.#index.options.maxObjects) {
			throw new OneNoteFormatError('ONENOTE_OBJECT_LIMIT', 'The object declaration limit was exceeded.', node.fileOffset);
		}

		const id = this.#resolveCompactId(node.data, 0, frame.scope, node.fileOffset);
		const jcid = readUInt32(node.data, 4);
		const large = node.id === FileNodeId.objectDeclarationFileData3LargeRefCount;
		const referenceCount = large ? readUInt32(node.data, 8) : readByte(node.data, 8);

		const reference = readStorageString(node.data, large ? 12 : 9, node.fileOffset);
		const extension = readStorageString(node.data, reference.next, node.fileOffset);
		const revision = frame.revisionOrder === NO_REVISION ? undefined : this.#index.revisionAt(frame.revisionOrder);

		this.#index.addObject({
			id,
			jcid,
			referenceCount,
			revisionOrder: frame.revisionOrder,
			revisionId: revision?.id,
			isRevision: false,
			fileDataReference: reference.value,
			fileExtension: extension.value,
			globalIdScope: frame.scope,
		});

		this.#index.store.set(
			this.#key.reset(Tag.knownJcid).extendedGuid(id).done(),
			this.#value.reset().u32(jcid).done());
	}

	/**
	 * A FileDataStoreObject's framing is checked here and its payload is not
	 * touched: the asset caps are enforced against the declared length, so a
	 * 60 MiB attachment costs nothing until something asks to write it.
	 */
	#readFileDataStoreObject(node: IndexedFileNode): void {
		if (!isRealChunk(node.chunkReference)) return;

		const reference = node.chunkReference;
		const referenceId = readGuid(node.data, reference.encodedLength);

		if (reference.length < 52) {
			throw new OneNoteFormatError('ONENOTE_FILE_DATA_LENGTH', 'A FileDataStoreObject is shorter than its required framing.', reference.offset);
		}

		const headerRange = this.#referencedRange(reference, 0, 36, 'file-data store object header');
		const header = this.#window.read(headerRange.offset, headerRange.length);
		const length = readUInt64(header, 16);

		if (length > reference.length - 52) {
			throw new OneNoteFormatError('ONENOTE_FILE_DATA_LENGTH', 'A FileDataStoreObject payload length exceeds its containing frame.', reference.offset + 16);
		}
		if (length > this.#index.options.maxAssetBytes
			|| this.#totalAssetBytes > this.#index.options.maxTotalAssetBytes - length) {
			throw new OneNoteFormatError('ONENOTE_ASSET_LIMIT', 'An embedded OneNote asset exceeds the configured materialization limits.', node.fileOffset);
		}

		const footerRange = this.#referencedRange(reference, reference.length - 16, 16, 'file-data store object footer');
		const footer = this.#window.peek(footerRange.offset, footerRange.length);

		if (readGuid(header, 0) !== FILE_DATA_HEADER || readGuid(footer, 0) !== FILE_DATA_FOOTER) {
			throw new OneNoteFormatError('ONENOTE_FILE_DATA_FRAMING', 'A FileDataStoreObject has invalid framing GUIDs.', reference.offset);
		}

		const payload = this.#referencedRange(reference, 36, length, 'file-data store object payload');
		this.#totalAssetBytes += length;
		this.#index.addFileData(referenceId, payload);
	}

	#referencedRange(reference: FileNodeChunk, relativeOffset: number, length: number, name: string): ByteRange {
		if (reference.offset > this.#declaredFileLength || reference.length > this.#declaredFileLength - reference.offset) {
			throw new OneNoteFormatError('ONENOTE_CHUNK_REFERENCE_BOUNDS', `The ${name} lies outside the declared file length.`, reference.offset);
		}
		if (length < 0 || relativeOffset > reference.length || length > reference.length - relativeOffset) {
			throw new OneNoteFormatError('ONENOTE_CHUNK_REFERENCE_BOUNDS', `The ${name} lies outside its containing chunk reference.`, reference.offset);
		}

		const offset = reference.offset + relativeOffset;
		if (offset + length > this.#window.size) {
			throw new OneNoteFormatError('ONENOTE_TRUNCATED_STRUCTURE', `The file ended while reading ${name}.`, offset);
		}

		return { offset, length };
	}

	// -- Disk-backed sets ---------------------------------------------------

	#seen(tag: number, scope: number, offset: number): boolean {
		return this.#index.store.has(this.#key.reset(tag).u32(scope).big(offset).done());
	}

	#mark(tag: number, scope: number, offset: number): void {
		this.#index.store.set(this.#key.reset(tag).u32(scope).big(offset).done(), EMPTY_VALUE);
	}

	#visitedList(offset: number): boolean {
		return this.#seen(Tag.visitedList, 0, offset);
	}

	#markVisitedList(offset: number): void {
		this.#mark(Tag.visitedList, 0, offset);
	}
}

/** [MS-ONESTORE] 2.2.4.4 — the FileChunkReference64x32 closing a fragment. */
function readNextFragment(data: Uint8Array): FileChunkReference {
	const length = readUInt32(data, 8);
	if (isAllOnes(data, 0, 8) && length === 0) return { offset: 0, length: 0, isNil: true };
	return { offset: readUInt64(data, 0), length, isNil: false };
}

export function indexRevisionStore(
	header: FileHeader,
	window: ByteWindow,
	options: SectionIndexOptions = {},
): SectionIndex {
	if (header.expectedFileLength === undefined || !header.rootFileNodeList) {
		throw new OneNoteFormatError(
			'ONENOTE_REVISION_STORE_HEADER',
			'The revision-store header does not expose its required root structures.');
	}

	const index = new IndexedSection('revision-store', header, window, options);

	try {
		new RevisionStoreIndexer(index).run();
	}
	catch (error) {
		index.close();
		throw error;
	}

	return index;
}
