import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const entries = (await readdir('tests')).filter(name => /\.test\.tsx?$/.test(name)).sort();
if (!entries.length) throw new Error('No test files found.');
const directory = await mkdtemp(join(process.cwd(), '.test-'));
try {
  await build({
    entryPoints: entries.map(name => join('tests', name)), outdir: directory, outExtension: { '.js': '.mjs' },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', target: 'node22',
    jsx: 'automatic', loader: { '.css': 'text' },
  });
  const files = entries.map(name => join(directory, name.replace(/\.tsx?$/, '.mjs')));
  const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
