/*
 * File-name rules, adapted from obsidian-importer `src/util.ts`
 * (MIT, Copyright (c) 2023 Obsidian). See NOTICE.md.
 *
 * The only change is that `Platform.isWin` becomes `process.platform`, so the
 * module carries no dependency on the Obsidian runtime. Keeping the rules
 * byte-identical otherwise is what lets output be compared against the
 * upstream importer's when a page converts oddly.
 */

const slashesRe = /[/\\]/g;
const illegalRe = /[?<>:*|"]/g;
const reservedRe = /^\.+$/;
const windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const windowsTrailingRe = /[. ]+$/;
const startsWithDotRe = /^[.\s]+/;
// Characters that interfere with wiki links.
const badLinkRe = /[[\]#|^]/g;

/** Remove C0 and C1 control characters from filesystem names. */
export function stripControlCharacters(name: string): string {
	let out = '';
	for (const ch of name) {
		const code = ch.charCodeAt(0);
		if (code <= 0x1f || (code >= 0x80 && code <= 0x9f)) continue;
		out += ch;
	}
	return out;
}

// Leave room below common 255-byte/unit limits for extensions and collision suffixes.
const MAX_NAME_BYTES = 240;

// Reserve 100 characters of Windows' path limit for the output location.
const WINDOWS_PATH_CHARS = 160;

// Leave room for `.md` and collision suffixes such as ` 99`.
const NAME_TAIL_CHARS = 8;

// Keep names readable when the parent path already exceeds the budget.
const MIN_NAME_CHARS = 24;

const encoder = new TextEncoder();

function charsAvailable(parentPath: string | undefined): number {
	if (process.platform !== 'win32') return Infinity;

	const used = parentPath ? parentPath.length + 1 : 0;
	return Math.max(MIN_NAME_CHARS, WINDOWS_PATH_CHARS - used - NAME_TAIL_CHARS);
}

function limitNameLength(name: string, maxChars: number): string {
	// UTF-8 needs at most three bytes per UTF-16 unit.
	if (name.length <= maxChars
		&& (name.length * 3 <= MAX_NAME_BYTES || encoder.encode(name).length <= MAX_NAME_BYTES)) return name;

	// Iteration by code point keeps surrogate pairs intact.
	let truncated = '';
	let bytes = 0;

	for (const character of name) {
		const size = encoder.encode(character).length;
		if (bytes + size > MAX_NAME_BYTES) break;
		if (truncated.length + character.length > maxChars) break;
		truncated += character;
		bytes += size;
	}

	const lastSpace = truncated.lastIndexOf(' ');
	if (lastSpace > truncated.length / 2) truncated = truncated.slice(0, lastSpace);

	return truncated;
}

function tidyName(name: string): string {
	return name
		.replace(reservedRe, '')
		.replace(windowsTrailingRe, '')
		.replace(windowsReservedRe, '')
		.replace(badLinkRe, '')
		.replace(startsWithDotRe, '');
}

/** @param parentPath Output-relative parent folder. */
export function sanitizeFileName(name: string | undefined | null, parentPath?: string): string {
	const cleaned = tidyName(stripControlCharacters(
		(name ?? '')
			.normalize('NFC')
			.replace(slashesRe, '-')
			.replace(illegalRe, '')));

	// Reapply trailing-space and reserved-name rules after truncation.
	const limited = limitNameLength(cleaned, charsAvailable(parentPath));
	const sanitized = limited === cleaned ? cleaned : tidyName(limited);

	// An empty result would produce files like `.md`, or folders that are only spaces.
	return sanitized.trim() || 'Untitled';
}

/** Append ` 1`, ` 2`, … until nothing has claimed the name. */
export function availableFileName(fileName: string, isTaken: (candidate: string) => boolean): string {
	const lastDotIndex = fileName.lastIndexOf('.');
	const hasExtension = lastDotIndex > 0;
	const base = hasExtension ? fileName.slice(0, lastDotIndex) : fileName;
	const extension = hasExtension ? fileName.slice(lastDotIndex) : '';

	for (let index = 0; ; index++) {
		const candidate = index === 0 ? fileName : `${base} ${index}${extension}`;
		if (!isTaken(candidate)) return candidate;
	}
}

/**
 * Tracks what each output folder already holds.
 *
 * Names are reserved as they are handed out rather than by looking at the disk,
 * so a dry run and a real run agree, and so two pages converted in the same
 * batch cannot both win the same name.
 */
export class NameRegistry {
	private taken = new Map<string, Set<string>>();

	private setFor(folder: string): Set<string> {
		let set = this.taken.get(folder);
		if (!set) this.taken.set(folder, set = new Set());
		return set;
	}

	/** Case-insensitive, because macOS and Windows filesystems are. */
	claim(folder: string, fileName: string): string {
		const set = this.setFor(folder);
		const chosen = availableFileName(fileName, candidate => set.has(candidate.toLowerCase()));
		set.add(chosen.toLowerCase());
		return chosen;
	}

	has(folder: string, fileName: string): boolean {
		return this.taken.get(folder)?.has(fileName.toLowerCase()) ?? false;
	}
}
