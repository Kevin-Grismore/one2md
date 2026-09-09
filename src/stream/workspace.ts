/**
 * What a batch has claimed, remembered on disk.
 *
 * `Workspace` holds two things that grow with the output rather than the input:
 * a set of every file name handed out, per folder, and a map from content
 * digest to the attachment already written for it. A notebook with fifty
 * thousand pages and its images has hundreds of thousands of entries in those,
 * and they are live for the whole batch because the last page can still collide
 * with the first.
 *
 * Both are lookups, though, and neither is ever iterated. That makes them
 * exactly what the paged store is for. So this is the same two structures with
 * the same behaviour — case-insensitive claiming, first-writer-wins dedup —
 * answering from a temporary file instead of from heap.
 *
 * The report is here for the same reason. A conversion's own account of itself
 * is four arrays that grow with the number of notes, attachments, skipped items
 * and failures, and a caller usually wants the counts and a name or two.
 * Records go to the store as they happen; `snapshot` builds the arrays only if
 * something asks for them.
 */
import { availableFileName } from '../names';
import { FailedItem } from '../convert-file';
import { SkipReason } from '../onenote-file/convert';
import { OneNoteFormatError } from '../onenote-file/errors';
import { PagedKeyValueStore, PagedKeyValueStoreOptions } from '../storage/paged-key-value-store';
import { RecordReader, RecordWriter } from '../storage/records';

const Tag = {
	claimed: 1,
	content: 2,
	note: 3,
	attachment: 4,
	skipped: 5,
	failure: 6,
	subpageLevel: 7,
	input: 8,
	group: 9,
} as const;

const EMPTY = new Uint8Array(0);

function codeOf(error: unknown): string | undefined {
	if (error instanceof OneNoteFormatError) return error.code;
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === 'string' ? code : undefined;
}

export interface StreamedAttachment {
	path: string;
	name: string;
}

export interface StreamedSkip {
	page: string;
	item: string;
	reason: SkipReason;
}

/** A report that is on disk, with the counts a caller usually wants in hand. */
export interface ReportSummary {
	noteCount: number;
	attachmentCount: number;
	skippedCount: number;
	errorCount: number;
	cancelled: boolean;
}

/**
 * How much of each report had been recorded at a moment.
 *
 * A batch shares one workspace, so its records are one run of notes, one run of
 * attachments and so on, in the order they happened. Which of them belong to
 * which input is therefore a pair of marks taken either side of that input —
 * four integers, rather than a copy of the records themselves. That is what
 * lets a per-input report be produced without ever holding one.
 */
export interface ReportMarks {
	notes: number;
	attachments: number;
	skipped: number;
	errors: number;
}

/** One input's share of a batch's records, as the range it occupies. */
export interface ReportGroup {
	input: string;
	from: ReportMarks;
	to: ReportMarks;
	cancelled: boolean;
}

/**
 * A batch's claimed names, written attachments and report, all on disk.
 *
 * One of these is shared across every file in a batch, which is what stops two
 * notebooks that both hold a section called "Notes" from writing over each
 * other. It owns a store and has to be closed.
 */
export class StreamWorkspace {
	readonly store: PagedKeyValueStore;

	readonly #key = new RecordWriter(256);
	readonly #value = new RecordWriter(256);
	readonly #owned: boolean;

	#notes = 0;
	#attachments = 0;
	#skipped = 0;
	#errors = 0;

	cancelled = false;

	/** Distinguishes one section's subpage stack from the next one's. */
	#stacks = 0;
	#inputs = 0;
	#groups = 0;

	constructor(store?: PagedKeyValueStore, options?: PagedKeyValueStoreOptions) {
		this.#owned = store === undefined;
		this.store = store ?? new PagedKeyValueStore(options);
	}

	// -- Names --------------------------------------------------------------

	/**
	 * Reserve a name in a folder, adding ` 1`, ` 2`, … until one is free.
	 *
	 * Case-insensitive, because macOS and Windows filesystems are, and reserved
	 * as it is handed out rather than by looking at the disk — so a dry run and
	 * a real run agree, and two pages in one batch cannot both win a name.
	 */
	claim(folder: string, fileName: string): string {
		const chosen = availableFileName(fileName, candidate => this.isClaimed(folder, candidate));
		this.store.set(this.#claimKey(folder, chosen), EMPTY);
		return chosen;
	}

	isClaimed(folder: string, fileName: string): boolean {
		return this.store.has(this.#claimKey(folder, fileName));
	}

	#claimKey(folder: string, fileName: string): Uint8Array {
		return this.#key.reset(Tag.claimed).text(folder).text(fileName.toLowerCase()).done();
	}

	// -- Content -------------------------------------------------------------

	/** The attachment already written for these bytes in this folder. */
	writtenFor(folder: string, digest: string): StreamedAttachment | undefined {
		const stored = this.store.get(this.#contentKey(folder, digest));
		if (!stored) return undefined;

		const reader = new RecordReader(stored);
		return { path: reader.text(), name: reader.text() };
	}

	rememberContent(folder: string, digest: string, attachment: StreamedAttachment): void {
		this.store.set(
			this.#contentKey(folder, digest),
			this.#value.reset().text(attachment.path).text(attachment.name).done());
	}

	#contentKey(folder: string, digest: string): Uint8Array {
		return this.#key.reset(Tag.content).text(folder).text(digest).done();
	}

	// -- Subpage nesting -------------------------------------------------------

	/**
	 * A place to keep one folder per level of subpage nesting.
	 *
	 * A page's own folder is only named once one of its subpages arrives, so
	 * the walk carries the folder it would use at each level it has reached. A
	 * page can only ever be one level deeper than the page before it, but that
	 * still means a section whose pages nest all the way down carries a folder
	 * per page — so they are carried here instead of in an array.
	 */
	openSubpageLevels(root: string): SubpageLevels {
		return new SubpageLevels(this.store, ++this.#stacks, root);
	}

	// -- Inputs --------------------------------------------------------------

	/**
	 * A discovered input, appended to the store rather than to an array.
	 *
	 * Naming a folder of ten thousand sections should not cost ten thousand
	 * paths in the heap before the first one is opened. The paths go here as
	 * they are found and come back out with `inputs()`.
	 */
	recordInput(path: string): void {
		this.store.set(
			this.#key.reset(Tag.input).u32(this.#inputs++).done(),
			this.#value.reset().text(path).done());
	}

	get inputCount(): number {
		return this.#inputs;
	}

	*inputs(): IterableIterator<string> {
		for (let index = 0; index < this.#inputs; index++) {
			yield new RecordReader(this.#read(Tag.input, index)).text();
		}
	}

	// -- Report --------------------------------------------------------------

	get summary(): ReportSummary {
		return {
			noteCount: this.#notes,
			attachmentCount: this.#attachments,
			skippedCount: this.#skipped,
			errorCount: this.#errors,
			cancelled: this.cancelled,
		};
	}

	/** Where each report stands now, for taking either side of an input. */
	get marks(): ReportMarks {
		return {
			notes: this.#notes,
			attachments: this.#attachments,
			skipped: this.#skipped,
			errors: this.#errors,
		};
	}

	/**
	 * One input's slice of the report, on disk beside the records it bounds.
	 *
	 * A group is four counts and a path, so an array of them is small next to
	 * a note — but it is still one entry per input, and the claim is about the
	 * converter's memory rather than about which parts of it are small.
	 */
	recordGroup(group: ReportGroup): void {
		this.store.set(
			this.#key.reset(Tag.group).u32(this.#groups++).done(),
			this.#value.reset()
				.text(group.input)
				.u32(group.from.notes).u32(group.from.attachments)
				.u32(group.from.skipped).u32(group.from.errors)
				.u32(group.to.notes).u32(group.to.attachments)
				.u32(group.to.skipped).u32(group.to.errors)
				.u8(group.cancelled ? 1 : 0)
				.done());
	}

	get groupCount(): number {
		return this.#groups;
	}

	*groups(): IterableIterator<ReportGroup> {
		for (let index = 0; index < this.#groups; index++) {
			const reader = new RecordReader(this.#read(Tag.group, index));
			yield {
				input: reader.text(),
				from: {
					notes: reader.u32(), attachments: reader.u32(),
					skipped: reader.u32(), errors: reader.u32(),
				},
				to: {
					notes: reader.u32(), attachments: reader.u32(),
					skipped: reader.u32(), errors: reader.u32(),
				},
				cancelled: reader.u8() === 1,
			};
		}
	}

	recordNote(path: string): void {
		this.store.set(
			this.#key.reset(Tag.note).u32(this.#notes++).done(),
			this.#value.reset().text(path).done());
	}

	recordAttachment(path: string): void {
		this.store.set(
			this.#key.reset(Tag.attachment).u32(this.#attachments++).done(),
			this.#value.reset().text(path).done());
	}

	recordSkipped(page: string, item: string, reason: SkipReason): void {
		this.store.set(
			this.#key.reset(Tag.skipped).u32(this.#skipped++).done(),
			this.#value.reset().text(page).text(item).text(reason).done());
	}

	recordFailure(name: string, error: unknown): void {
		const failure: FailedItem = {
			name,
			kind: error instanceof OneNoteFormatError ? error.kind : 'unknown',
			// A `PagedStoreError`, a `ByteSourceError` and a `BudgetError` all
			// carry a code and none of them is a format error, so the code is
			// taken from whatever has one. It is what a caller looks up advice
			// by, and a store that ran out of temporary space deserves advice
			// as much as a malformed section does.
			code: codeOf(error),
			message: error instanceof Error ? error.message : String(error),
		};

		this.store.set(
			this.#key.reset(Tag.failure).u32(this.#errors++).done(),
			this.#value.reset()
				.text(failure.name)
				.text(failure.kind)
				.optionalText(failure.code)
				.text(failure.message)
				.done());
	}

	/**
	 * The records, in the order they happened, over any half-open range.
	 *
	 * Defaulting to the whole run keeps the batch-wide reading these had
	 * before; passing a range is how one input's share is read back without a
	 * per-input structure existing anywhere.
	 */
	*notes(from = 0, to = this.#notes): IterableIterator<string> {
		for (let index = from; index < to; index++) {
			yield new RecordReader(this.#read(Tag.note, index)).text();
		}
	}

	*attachments(from = 0, to = this.#attachments): IterableIterator<string> {
		for (let index = from; index < to; index++) {
			yield new RecordReader(this.#read(Tag.attachment, index)).text();
		}
	}

	*skips(from = 0, to = this.#skipped): IterableIterator<StreamedSkip> {
		for (let index = from; index < to; index++) {
			const reader = new RecordReader(this.#read(Tag.skipped, index));
			yield { page: reader.text(), item: reader.text(), reason: reader.text() as SkipReason };
		}
	}

	*failures(from = 0, to = this.#errors): IterableIterator<FailedItem> {
		for (let index = from; index < to; index++) {
			const reader = new RecordReader(this.#read(Tag.failure, index));
			const name = reader.text();
			const kind = reader.text() as FailedItem['kind'];
			const code = reader.optionalText();
			yield { name, kind, code, message: reader.text() };
		}
	}

	#read(tag: number, index: number): Uint8Array {
		return this.store.get(this.#key.reset(tag).u32(index).done())!;
	}

	close(): void {
		if (this.#owned) this.store.close();
	}
}

/**
 * The folder each level of subpage nesting would write into.
 *
 * An array with a `length =` truncation, kept in the store. The truncation is
 * the interesting part: setting a level discards every level below it, and
 * `#depth` is what makes that free — a level past the depth is not read, so it
 * does not have to be deleted.
 */
export class SubpageLevels {
	readonly #store: PagedKeyValueStore;
	readonly #key = new RecordWriter(32);
	readonly #value = new RecordWriter(256);
	readonly #stack: number;

	#depth = 0;

	constructor(store: PagedKeyValueStore, stack: number, root: string) {
		this.#store = store;
		this.#stack = stack;
		this.set(0, root);
	}

	/** The deepest level that has a folder, which is what a page's level clamps to. */
	get depth(): number {
		return this.#depth;
	}

	at(level: number): string {
		const stored = this.#store.get(this.#keyFor(level));
		if (!stored) throw new RangeError(`No folder is recorded for subpage level ${level}.`);
		return new RecordReader(stored).text();
	}

	set(level: number, folder: string): void {
		this.#store.set(this.#keyFor(level), this.#value.reset().text(folder).done());
		this.#depth = level;
	}

	/** Forget everything below `level`, as `levels.length = level + 1` did. */
	truncate(level: number): void {
		this.#depth = level;
	}

	#keyFor(level: number): Uint8Array {
		return this.#key.reset(Tag.subpageLevel).u32(this.#stack).u32(level).done();
	}
}
