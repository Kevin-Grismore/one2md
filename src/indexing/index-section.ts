/**
 * The one way in: index a loose `.one` section, whichever way it was written.
 *
 * `readSection` makes the same choice for the in-memory path — the file header
 * says whether a section is a desktop revision store or a packaged one, and it
 * validates both, so which reader applies is read from the file rather than
 * guessed from its name. This is that fork for the bounded path, and it hands
 * back one `SectionIndex` either way.
 *
 * Nothing here materializes the section. The header is the only part of the
 * file read up front, and it is at most a kilobyte.
 */
import { OneNoteFormatError } from '../onenote-file/errors';
import { REVISION_STORE_HEADER_LENGTH } from '../onenote-file/onestore/constants';
import { FileHeader, readFileHeader } from '../onenote-file/onestore/file-header';
import { DEFAULT_READER_OPTIONS, ReaderOptions } from '../onenote-file/onestore/options';
import { ByteSource } from '../storage/byte-source';
import { ByteWindow } from '../storage/byte-window';
import { indexPackage, PackageIndexedSection } from './fsshttpb-index';
import { indexRevisionStore } from './onestore-index';
import { DEFAULT_SECTION_INDEX_OPTIONS, SectionIndex, SectionIndexOptions } from './section-index';

export { PackageIndexedSection } from './fsshttpb-index';
export * from './section-index';

/** Read the header, and only the header, from the front of a section. */
export function readSectionHeader(
	window: ByteWindow,
	options: ReaderOptions = DEFAULT_READER_OPTIONS,
): FileHeader {
	const span = Math.min(REVISION_STORE_HEADER_LENGTH, window.size);
	return readFileHeader(window.read(0, span), window.size, options);
}

export function indexSection(source: ByteSource, options: SectionIndexOptions = {}): SectionIndex {
	const window = new ByteWindow(source, options.windowBytes ?? DEFAULT_SECTION_INDEX_OPTIONS.windowBytes);
	const header = readSectionHeader(window, options.reader ?? DEFAULT_READER_OPTIONS);

	switch (header.storageFormat) {
		case 'revision-store':
			return indexRevisionStore(header, window, options);
		case 'file-synchronization-package':
			return indexPackage(header, window, options);
		default:
			throw new OneNoteFormatError(
				'ONENOTE_NOT_A_SECTION',
				'Bounded-memory indexing reads a loose .one section; this artifact is neither a desktop revision store nor a packaged one.');
	}
}

/** The packaged form, for a caller that already knows which encoding it has. */
export function indexPackagedSection(
	source: ByteSource,
	options: SectionIndexOptions = {},
): PackageIndexedSection {
	const window = new ByteWindow(source, options.windowBytes ?? DEFAULT_SECTION_INDEX_OPTIONS.windowBytes);
	const header = readSectionHeader(window, options.reader ?? DEFAULT_READER_OPTIONS);

	if (header.storageFormat !== 'file-synchronization-package') {
		throw new OneNoteFormatError(
			'ONENOTE_NOT_A_PACKAGE',
			'The section does not use the MS-FSSHTTPB packaged encoding.');
	}

	return indexPackage(header, window, options);
}
