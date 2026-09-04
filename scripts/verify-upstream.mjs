/**
 * Check the vendored parser against obsidian-importer, over the network.
 *
 * Two questions, both worth being able to answer on demand:
 *
 *   1. Has any vendored file drifted from the pinned upstream commit? Only the
 *      two import lines in convert.ts are meant to differ.
 *   2. Does this repository still produce upstream's recorded markdown and
 *      attachments byte for byte, ignoring the front matter added here?
 *
 * Run it after re-pinning UPSTREAM_COMMIT, or when a conversion looks wrong and
 * you want to know whether the parser or this repository's glue is at fault.
 *
 *   node scripts/verify-upstream.mjs [--sync]
 *
 * --sync rewrites the vendored files from the pinned commit instead of only
 * reporting on them, reapplying the two import rewrites afterwards.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertFile } from '../src/convert-file.ts';
import { MemorySink } from '../src/sinks.ts';
import { readSection } from '../src/read-section.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sync = process.argv.includes('--sync');
const commit = readFileSync(path.join(root, 'src/onenote-file/UPSTREAM_COMMIT'), 'utf8').trim();
const raw = `https://raw.githubusercontent.com/obsidianmd/obsidian-importer/${commit}`;

const VENDORED = [
	'convert.ts', 'package.ts', 'onex.ts', 'backup-folder.ts', 'errors.ts',
	'cabinet/cabinet.ts', 'cabinet/lzx.ts',
	'onestore/binary.ts', 'onestore/constants.ts', 'onestore/file-header.ts',
	'onestore/file-node-list.ts', 'onestore/objects.ts', 'onestore/options.ts',
	'onestore/property-set.ts', 'onestore/revision-store.ts', 'onestore/transaction-log.ts',
	'semantic/content.ts', 'semantic/ink.ts', 'semantic/map.ts',
	'semantic/object-space.ts', 'semantic/properties.ts', 'semantic/schema.ts',
];

/** The only edits the vendoring makes, so the copy is self-contained. */
function reapplyRewrites(source) {
	return source
		.replace("from '../onenote/ink-svg'", "from './ink-svg'")
		.replace("from '../../util'", "from './util'");
}

async function fetchText(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	return response.text();
}

async function fetchBytes(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
	return new Uint8Array(await response.arrayBuffer());
}

let problems = 0;

console.log(`Pinned upstream commit ${commit}\n`);
console.log('Vendored files');

for (const file of [...VENDORED, 'ink-svg.ts']) {
	const upstreamPath = file === 'ink-svg.ts'
		? 'src/formats/onenote/ink-svg.ts'
		: `src/formats/onenote-file/${file}`;
	const local = path.join(root, 'src/onenote-file', file);
	const upstream = reapplyRewrites(await fetchText(`${raw}/${upstreamPath}`));

	if (readFileSync(local, 'utf8') === upstream) {
		console.log(`  ok       ${file}`);
		continue;
	}

	if (sync) {
		writeFileSync(local, upstream);
		console.log(`  synced   ${file}`);
	}
	else {
		console.log(`  DRIFTED  ${file}`);
		problems++;
	}
}

console.log('\nRecorded output, front matter aside');

const CASES = {
	'testOneNote.one': 'testOneNote.one',
	'testOneNote2016.one': 'testOneNote2016.one',
	'testOneNoteEmbeddedWordDoc.one': 'testOneNoteEmbeddedWordDoc.one',
	'handwriting_recognition.one': 'handwriting_recognition.one',
};

const stripFrontMatter = text => text.replace(/^---\n[\s\S]*?\n---\n/, '');

for (const [fixture, expectedDir] of Object.entries(CASES)) {
	const data = new Uint8Array(readFileSync(path.join(root, 'tests/fixtures', fixture)));
	const sink = new MemorySink();
	await convertFile(data, fixture, sink);

	for (const [relative, bytes] of sink.files) {
		const url = `${raw}/tests/onenote-file/fixtures/expected/${expectedDir}/${relative.split('/').map(encodeURIComponent).join('/')}`;

		let upstream;
		try {
			upstream = await fetchBytes(url);
		}
		catch {
			console.log(`  ABSENT   ${expectedDir}/${relative}`);
			problems++;
			continue;
		}

		const same = relative.endsWith('.md')
			? stripFrontMatter(Buffer.from(bytes).toString('utf8')) === stripFrontMatter(Buffer.from(upstream).toString('utf8'))
			: Buffer.from(bytes).equals(Buffer.from(upstream));

		console.log(`  ${same ? 'ok      ' : 'DIFFERS '} ${expectedDir}/${relative}`);
		if (!same) problems++;
	}
}

// The packaged reader hands `mapSection` a store whose `root` and `lists` are
// empty, because nothing above the storage layer reads them. That is true of
// the pinned commit and is not a promise upstream has made. Upstream has no
// recording for these files, so the check above cannot cover them — this does,
// loudly, at the moment a re-sync would otherwise break them silently.
console.log('\nPackaged reader, after sync');

for (const fixture of ['testOneNoteFromOffice365.one', 'packagedWithAttachments.one']) {
	const file = path.join(root, 'tests/fixtures', fixture);
	if (!existsSync(file)) {
		console.log(`  MISSING  ${fixture}`);
		problems++;
		continue;
	}

	try {
		const section = readSection(new Uint8Array(readFileSync(file)));
		const pages = section.pages.length;

		if (pages === 0) throw new Error('no pages');
		console.log(`  ok       ${fixture} — ${pages} page(s)`);
	}
	catch (error) {
		console.log(`  BROKEN   ${fixture}: ${error.message}`);
		console.log('           A vendored change altered what mapSection needs from its store.');
		problems++;
	}
}

console.log(problems === 0
	? '\nAgrees with upstream.'
	: `\n${problems} difference(s). Re-run with --sync to take upstream's files, then run the tests.`);

process.exit(problems === 0 ? 0 : 1);
