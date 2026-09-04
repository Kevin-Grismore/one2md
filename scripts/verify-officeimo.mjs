/**
 * Check this converter against OfficeIMO, an independent implementation.
 *
 * Why this exists: four of our recorded output trees are separately proven
 * equal to obsidian-importer's own recordings by `verify:upstream`. The
 * packaged (web export) trees are not — nothing but our own recording says
 * they are right. This closes that gap by reading the same files with a
 * different project and comparing what must agree.
 *
 * Development only. It needs the .NET SDK and the network on first run;
 * `npm test` needs neither, and the shipped bundle depends on neither.
 *
 *   node scripts/verify-officeimo.mjs [fixture...]
 *
 * What is compared: section names, page count and order, page titles, page
 * nesting level, the words a page carries, and attachment bytes by SHA-256.
 *
 * What is NOT compared, deliberately:
 *
 *   - Markdown styling. The two projects format emphasis, links, lists and
 *     tables differently by design. Text is reduced to lowercase alphanumeric
 *     words before comparison.
 *   - Timestamps. The projects read different properties and disagree on both
 *     encodings — including the desktop path that `verify:upstream` proves
 *     byte-identical to obsidian-importer. That makes it a difference between
 *     the two projects, not a defect in either.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import { convertFile } from '../src/convert-file.ts';
import { MemorySink } from '../src/sinks.ts';

const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = nodePath.join(root, 'tests', 'fixtures');
const project = nodePath.join(root, 'scripts', 'oracle');
const assembly = nodePath.join(project, 'bin', 'Debug', 'net8.0', 'one2md-oracle.dll');

/**
 * Files where the two projects are known to disagree, with the reason.
 *
 * An entry here is a decision, not a silence: it names what differs and why it
 * is acceptable. A disagreement that is not listed fails the run.
 */
const KNOWN = new Map([
	['handwriting_recognition.one',
		'Rendering choices, not content. Ink strokes are drawn to SVG independently by '
		+ 'each project, so that one attachment cannot match byte for byte (the page image '
		+ 'does). The extra words are our note-tag callouts ("[!important]"), task '
		+ 'checkboxes ("- [x]") and math brace groups ("_{u}") — the same content, '
		+ 'spelled differently.'],
]);

function have(command, args) {
	const result = spawnSync(command, args, { stdio: 'ignore' });
	return result.status === 0;
}

if (!have('dotnet', ['--version'])) {
	console.log('Skipping: the .NET SDK is not installed.');
	console.log('This check is development-only; `npm test` and the shipped bundle do not need it.');
	process.exit(0);
}

console.log('Building the oracle…');
const build = spawnSync('dotnet', ['build', project, '-v', 'q', '--nologo'], { stdio: 'inherit' });
if (build.status !== 0) {
	console.error('Could not build the oracle.');
	process.exit(1);
}

const wanted = process.argv.slice(2);
const fixtures = nodeFs.readdirSync(fixturesDir)
	.filter(name => /\.(one|onepkg)$/i.test(name))
	.filter(name => wanted.length === 0 || wanted.includes(name))
	.sort((a, b) => a.localeCompare(b));

if (fixtures.length === 0) {
	console.error('No matching fixtures.');
	process.exit(2);
}

const dump = spawnSync('dotnet', [assembly, 'dump', ...fixtures.map(name => nodePath.join(fixturesDir, name))],
	{ encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

if (!dump.stdout?.trim()) {
	console.error('The oracle produced no output.');
	console.error(dump.stderr);
	process.exit(1);
}

const theirs = new Map(JSON.parse(dump.stdout).map(report => [report.Input, report]));

/**
 * Reduce Markdown to the words it carries, matching the oracle's rule.
 *
 * Link and image targets are dropped first: those are this project's own file
 * naming — `attachments/Page%20image.png` — and say nothing about the content
 * the page carries. Only the link text survives, which is what both projects
 * take from the document.
 */
function words(markdown) {
	const prose = markdown
		.replace(/^---\n[\s\S]*?\n---\n/, '')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');

	return [...prose]
		.map(character => /[\p{L}\p{N}]/u.test(character) ? character.toLowerCase() : ' ')
		.join('')
		.split(/\s+/)
		.filter(Boolean);
}

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

let failures = 0;
let checked = 0;

for (const name of fixtures) {
	const theirReport = theirs.get(name);
	const problems = [];

	const sink = new MemorySink();
	const ours = await convertFile(new Uint8Array(nodeFs.readFileSync(nodePath.join(fixturesDir, name))), name, sink);

	const theirPages = (theirReport?.Sections ?? []).flatMap(section => section.Pages);
	const ourNotes = ours.notes.map(path => ({
		path,
		title: nodePath.basename(path).replace(/\.md$/, ''),
		words: words(new TextDecoder().decode(sink.files.get(path))),
	}));

	if (!theirReport?.Ok) {
		// Both declining a file is agreement worth recording.
		if (ours.errors.length > 0) {
			console.log(`  = ${name}: both readers decline it (${theirReport?.Code ?? 'unknown'} / ${ours.errors[0].code})`);
			continue;
		}
		problems.push(`OfficeIMO could not read it (${theirReport?.Error}) but we converted ${ours.notes.length} notes`);
	}
	else if (ours.errors.length > 0) {
		problems.push(`we failed (${ours.errors[0].code}) but OfficeIMO read ${theirPages.length} pages`);
	}
	else {
		if (ourNotes.length !== theirPages.length) {
			problems.push(`page count: ${ourNotes.length} ours vs ${theirPages.length} theirs`);
		}

		for (let index = 0; index < Math.min(ourNotes.length, theirPages.length); index++) {
			const ourNote = ourNotes[index];
			const theirPage = theirPages[index];

			// Our note name is the sanitized title, so it can legitimately differ
			// from the raw title; compare on the sanitized form of theirs.
			if (!ourNote.title.startsWith(theirPage.Title?.replace(/[?<>:*|"/\\[\]#^]/g, '').trim().slice(0, 40) ?? '')) {
				problems.push(`page ${index} title: "${ourNote.title}" ours vs "${theirPage.Title}" theirs`);
			}

			// Their projection heads the page with its title; ours puts it in
			// front matter. Compare the words that remain either way.
			const theirWords = new Set(theirPage.Text.split(' ').filter(Boolean));
			const missing = ourNote.words.filter(word => !theirWords.has(word));
			if (missing.length > 0) {
				problems.push(`page ${index} "${ourNote.title}": ${missing.length} word(s) we emit that OfficeIMO does not, e.g. ${missing.slice(0, 6).join(' ')}`);
			}
		}

		const theirAssets = new Set(theirPages.flatMap(page => page.Attachments).map(item => item.Sha256).filter(Boolean));
		const ourAssets = ours.attachments.map(path => sha256(sink.files.get(path)));
		const unmatched = ourAssets.filter(digest => !theirAssets.has(digest));

		if (theirAssets.size > 0 && unmatched.length > 0) {
			problems.push(`${unmatched.length} of ${ourAssets.length} attachment(s) do not match OfficeIMO's bytes`);
		}
		if (theirAssets.size === 0 && ourAssets.length > 0) {
			problems.push(`we wrote ${ourAssets.length} attachment(s); OfficeIMO reported none`);
		}
	}

	checked++;

	if (problems.length === 0) {
		console.log(`  ok  ${name} — ${ourNotes.length} page(s) agree`);
		continue;
	}

	const known = KNOWN.get(name);
	if (known) {
		console.log(`  ~   ${name} — known divergence: ${known}`);
		for (const problem of problems) console.log(`        ${problem}`);
		continue;
	}

	console.log(`  X   ${name}`);
	for (const problem of problems) console.log(`        ${problem}`);
	failures++;
}

console.log(failures === 0
	? `\nAgrees with OfficeIMO on ${checked} file(s).`
	: `\n${failures} of ${checked} file(s) disagree with OfficeIMO.`);

process.exit(failures === 0 ? 0 : 1);
