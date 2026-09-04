/**
 * Reading a section, whichever way it was written.
 *
 * OneNote produces two encodings under the same `.one` extension. The desktop
 * application writes a revision store; the sync path — which is what an export
 * from OneNote on the web gives you — writes an MS-FSSHTTPB package. They share
 * everything above the storage layer, so this module is only a fork in the road:
 * decide which reader applies, and hand `mapSection` the object graph either
 * one produces.
 *
 * This exists rather than an edit to the vendored `package.ts` because that
 * directory is a verbatim copy of obsidian-importer and is checked as one. The
 * cabinet and `.onex` handling below deliberately mirrors it.
 */
import { CabinetLimits, DEFAULT_CABINET_LIMITS, readCabinet, readCabinetIndex } from './onenote-file/cabinet/cabinet';
import { OneNoteFormatError } from './onenote-file/errors';
import { isCompoundFile, inspectOnex } from './onenote-file/onex';
import { readFileHeader } from './onenote-file/onestore/file-header';
import { DEFAULT_READER_OPTIONS, ReaderOptions } from './onenote-file/onestore/options';
import { readRevisionStore } from './onenote-file/onestore/revision-store';
import { Section } from './onenote-file/semantic/content';
import { mapSection } from './onenote-file/semantic/map';
import { buildObjectGraph } from './fsshttpb/object-graph';

export interface SectionEntry {
	name: string;
	title: string;
	/** The section groups this section sits in, outermost first. */
	groups: string[];
}

export interface ReadableSection extends SectionEntry {
	read: () => Section;
}

const SECTION_EXTENSION = /\.one$/i;

function titleOf(name: string): string {
	return name.replace(/^.*[\\/]/, '').replace(SECTION_EXTENSION, '');
}

export function groupsOf(name: string): string[] {
	const parts = name.split(/[\\/]/);
	parts.pop();
	return parts.filter(part => part !== '' && part !== '.');
}

function isSection(name: string): boolean {
	return SECTION_EXTENSION.test(name);
}

/** A Microsoft Cabinet archive, which is what a `.onepkg` notebook is. */
export function isPackage(data: Uint8Array): boolean {
	return data.length >= 4 && data[0] === 0x4d && data[1] === 0x53 && data[2] === 0x43 && data[3] === 0x46;
}

/**
 * Decode one section, from either encoding.
 *
 * The file header says which, and it validates both — so the choice is read
 * from the file rather than guessed at from its name or its contents.
 */
export function readSection(data: Uint8Array, options: ReaderOptions = DEFAULT_READER_OPTIONS): Section {
	const header = readFileHeader(data, data.length, options);

	if (header.storageFormat === 'file-synchronization-package') {
		// `mapSection` reads only the graph. The remaining fields exist to
		// satisfy the shape a desktop store has; nothing consumes them.
		return mapSection({
			header,
			root: { id: 0, nodes: [] },
			lists: [],
			graph: buildObjectGraph(data, options),
		}, options);
	}

	return mapSection(readRevisionStore(data, options), options);
}

/**
 * The sections a file holds and how to decode each one.
 *
 * Decoding is deferred so that listing a notebook stays cheap, and so a section
 * that fails to read costs only itself.
 */
export function readSections(
	data: Uint8Array,
	fallbackName: string,
	wanted?: ReadonlySet<string>,
	limits: CabinetLimits = DEFAULT_CABINET_LIMITS,
	options: ReaderOptions = DEFAULT_READER_OPTIONS,
): ReadableSection[] {
	if (isCompoundFile(data)) {
		const kind = inspectOnex(data);
		throw new OneNoteFormatError(
			kind === 'rights-protected' ? 'ONENOTE_ONEX_PROTECTED' : 'ONENOTE_ONEX_UNSUPPORTED',
			kind === 'rights-protected'
				? 'The .onex file is rights-protected and its contents are encrypted.'
				: 'The .onex file is a compound document this importer does not recognise.');
	}

	if (!isPackage(data)) {
		return [{
			name: fallbackName,
			title: titleOf(fallbackName),
			groups: [],
			read: () => readSection(data, options),
		}];
	}

	return readCabinet(data, limits, name => isSection(name) && (!wanted || wanted.has(name)))
		.map(entry => ({
			name: entry.name,
			title: titleOf(entry.name),
			groups: groupsOf(entry.name),
			read: () => readSection(entry.data, options),
		}));
}

/** The sections a file holds, without decoding any of them. */
export function listSections(
	data: Uint8Array,
	fallbackName: string,
	limits: CabinetLimits = DEFAULT_CABINET_LIMITS,
): SectionEntry[] {
	if (!isPackage(data)) return [{ name: fallbackName, title: titleOf(fallbackName), groups: [] }];

	return readCabinetIndex(data, limits).entries
		.filter(entry => isSection(entry.name))
		.map(entry => ({ name: entry.name, title: titleOf(entry.name), groups: groupsOf(entry.name) }));
}
