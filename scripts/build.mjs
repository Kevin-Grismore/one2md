/**
 * Bundle the CLI to a single file with no runtime dependencies.
 *
 * The point is what runs on the other end: `node dist/one2md.mjs` and nothing
 * else — no `npm install`, no `node_modules`, no network. That is what makes
 * this usable from a sandbox, so the bundle is committed.
 */
import { build } from 'esbuild';
import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'one2md.mjs');

mkdirSync(path.join(root, 'dist'), { recursive: true });

await build({
	entryPoints: [path.join(root, 'src', 'cli.ts')],
	outfile,
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node20',
	// node:crypto is the only builtin used, and it is present in every runtime
	// this targets. Nothing else resolves outside src/.
	external: ['node:*'],
	banner: { js: '#!/usr/bin/env node' },
	legalComments: 'none',
	minify: false,
	sourcemap: false,
	logLevel: 'info',
});

chmodSync(outfile, 0o755);

// The skill directory has to be self-contained: someone drops it into
// .claude/skills/ and it works, without this repository beside it.
const inSkill = path.join(root, 'skills', 'onenote-to-markdown', 'one2md.mjs');
copyFileSync(outfile, inSkill);
chmodSync(inSkill, 0o755);

for (const file of [outfile, inSkill]) {
	console.log(`${path.relative(root, file)}: ${(statSync(file).size / 1024).toFixed(1)} KiB`);
}
