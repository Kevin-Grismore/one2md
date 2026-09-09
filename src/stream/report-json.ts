/**
 * The `--json` report, written instead of built.
 *
 * The eager CLI ends with `JSON.stringify({ ok, out, dryRun, reports }, null, 2)`.
 * That one call materializes three things at once: the arrays of every note,
 * attachment, skipped item and failure; the object tree wrapping them; and the
 * string, which for a notebook of fifty thousand pages is several megabytes of
 * contiguous heap produced in a single allocation.
 *
 * None of it is necessary. JSON is a stream, the records are already on disk in
 * the order they were recorded, and stdout takes bytes. So this writes the same
 * document a piece at a time, and the peak cost is one record plus the output
 * buffer.
 *
 * ## Byte-for-byte
 *
 * The schema is not merely equivalent to the eager one, it is identical, which
 * matters because a caller may well be diffing the two. That is achieved by
 * doing as little formatting here as possible: every leaf — a note's path, a
 * skipped item, a failure — is handed to `JSON.stringify` itself and its lines
 * are re-indented to the depth they sit at. So the escaping of an odd file
 * name, the omission of an absent `code`, the exact spacing after a colon: all
 * of it comes from the same implementation the eager path used, rather than
 * from a second attempt at the same rules.
 *
 * An empty array is the one case with its own shape. `JSON.stringify` writes
 * `[]` for one and a multi-line block for a non-empty one, so emptiness has to
 * be known before the bracket is written — which is why the counts are taken
 * from the marks rather than discovered while iterating.
 */
import { FailedItem } from '../convert-file';
import { ReportGroup, StreamedSkip, StreamWorkspace } from './workspace';

/** Two spaces per level, as `JSON.stringify(value, null, 2)` uses. */
const INDENT = '  ';

/** Somewhere to write text without holding all of it. */
export interface TextOut {
	write(text: string): void;
}

/**
 * A buffered writer over anything that takes a string.
 *
 * `process.stdout.write` per record would be a syscall per note, so pieces are
 * gathered until they are worth writing. The buffer is a fixed size and the
 * only thing here that holds bytes.
 */
export class BufferedTextOut implements TextOut {
	readonly #target: (text: string) => void;
	readonly #capacity: number;
	#pending = '';

	constructor(target: (text: string) => void, capacity = 8192) {
		this.#target = target;
		this.#capacity = capacity;
	}

	write(text: string): void {
		this.#pending += text;
		if (this.#pending.length >= this.#capacity) this.flush();
	}

	flush(): void {
		if (this.#pending === '') return;
		const pending = this.#pending;
		this.#pending = '';
		this.#target(pending);
	}
}

/**
 * The whole `--json` document for a bounded run.
 *
 * `ok` comes first because it does in the eager output, which is why the groups
 * are collected before this is called: whether the run failed is not known
 * until the last input is done. A group is four integers and a path, so the
 * The groups are taken as an iterable and read out of the store one at a time,
 * so the report of a batch costs one group rather than all of them. Whether a
 * group is the last is discovered by keeping one ahead of the writer, which is
 * what a comma between array elements needs and the cheapest way to know it.
 */
export function writeJsonReport(
	out: TextOut,
	workspace: StreamWorkspace,
	groups: Iterable<ReportGroup>,
	meta: { ok: boolean, out: string, dryRun: boolean },
): void {
	out.write('{\n');
	out.write(`${INDENT}"ok": ${meta.ok},\n`);
	out.write(`${INDENT}"out": ${JSON.stringify(meta.out)},\n`);
	out.write(`${INDENT}"dryRun": ${meta.dryRun},\n`);

	const walk = groups[Symbol.iterator]();
	let next = walk.next();

	if (next.done) {
		out.write(`${INDENT}"reports": []\n`);
		out.write('}\n');
		return;
	}

	out.write(`${INDENT}"reports": [\n`);

	while (!next.done) {
		const group = next.value;
		next = walk.next();
		writeGroup(out, workspace, group, 2);
		out.write(next.done ? '\n' : ',\n');
	}

	out.write(`${INDENT}]\n`);
	out.write('}\n');
}

/** One input's report, at the given indentation depth. */
function writeGroup(out: TextOut, workspace: StreamWorkspace, group: ReportGroup, depth: number): void {
	const pad = INDENT.repeat(depth);
	const inner = INDENT.repeat(depth + 1);

	out.write(`${pad}{\n`);
	out.write(`${inner}"input": ${JSON.stringify(group.input)},\n`);

	writeArray(out, 'notes', depth + 1,
		group.to.notes - group.from.notes,
		workspace.notes(group.from.notes, group.to.notes));
	out.write(',\n');

	writeArray(out, 'attachments', depth + 1,
		group.to.attachments - group.from.attachments,
		workspace.attachments(group.from.attachments, group.to.attachments));
	out.write(',\n');

	writeArray(out, 'skipped', depth + 1,
		group.to.skipped - group.from.skipped,
		workspace.skips(group.from.skipped, group.to.skipped));
	out.write(',\n');

	writeArray(out, 'errors', depth + 1,
		group.to.errors - group.from.errors,
		workspace.failures(group.from.errors, group.to.errors));
	out.write(',\n');

	out.write(`${inner}"cancelled": ${group.cancelled}\n`);
	out.write(`${pad}}`);
}

/**
 * One named array, from an iterator, without a trailing newline.
 *
 * The caller writes the comma or the newline that follows, because only it
 * knows whether another key comes after this one.
 */
function writeArray(
	out: TextOut,
	name: string,
	depth: number,
	count: number,
	items: Iterable<string | StreamedSkip | FailedItem>,
): void {
	const pad = INDENT.repeat(depth);

	if (count === 0) {
		out.write(`${pad}"${name}": []`);
		return;
	}

	out.write(`${pad}"${name}": [\n`);

	let written = 0;
	for (const item of items) {
		out.write(indented(item, depth + 1));
		out.write(++written === count ? '\n' : ',\n');
	}

	out.write(`${pad}]`);
}

/**
 * One leaf, formatted by `JSON.stringify` and moved to its depth.
 *
 * A string leaf is one line and needs only the prefix. An object leaf is
 * several, and `stringify` indents them from column zero, so every line after
 * the first gets the prefix as well — which is exactly what nesting the value
 * inside an array at this depth would have produced.
 */
function indented(item: string | StreamedSkip | FailedItem, depth: number): string {
	const pad = INDENT.repeat(depth);
	const text = JSON.stringify(item, null, 2);
	return pad + text.split('\n').join(`\n${pad}`);
}
