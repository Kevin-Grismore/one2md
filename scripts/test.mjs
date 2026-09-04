import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const filters = process.argv.slice(2);
const patterns = filters.length > 0 ? filters : ['tests/**/*.test.ts'];

const tsx = path.join(root, 'node_modules', '.bin', 'tsx');

const result = spawnSync(tsx, ['--test', ...patterns], {
	cwd: root,
	stdio: 'inherit',
	// A conversion formats dates in local time, so a recording made in one zone
	// would differ by a day when read in another. Node reads TZ once at startup.
	env: { ...process.env, TZ: 'UTC' },
});

process.exit(result.status ?? 1);
