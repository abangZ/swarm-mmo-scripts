import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const banner = `// ==UserScript==
// @name         Swarm MMO 助手
// @namespace    swarm-mmo-scripts
// @version      ${version}
// @description  分区自动扩张与集结进攻，共享兵力预算、独立派兵队列与运行日志
// @match        https://www.swarm-mmo.com/play*
// @match        https://swarm-mmo.com/play*
// @run-at       document-idle
// @grant        none
// @sandbox      raw
// ==/UserScript==`;
// Generated locally: the absolute file URL follows this checkout, including escaped spaces.
const localBundle = new URL('../dist/swarm-mmo.user.js', import.meta.url);
const loader = banner
  .replace('// @name         Swarm MMO 助手', '// @name         Swarm MMO 助手（本地开发）')
  .replace('// ==/UserScript==', `// @require      ${localBundle.href}\n// ==/UserScript==`);
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/swarm-mmo-local.user.js', import.meta.url), `${loader}\n\n// 功能代码由上面的本地 @require 加载。修改源码并构建后，刷新游戏页面即可。\n`);
const watch = process.argv.includes('--watch');
const options = {
  entryPoints: ['src/main.ts'],
  outfile: 'dist/swarm-mmo.user.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  minify: !watch,
  banner: { js: banner },
  legalComments: 'inline',
};
if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching → dist/swarm-mmo.user.js\nLocal loader → dist/swarm-mmo-local.user.js (install once, then reload the game after edits)');
} else {
  await build(options);
  console.log('Built dist/swarm-mmo.user.js');
}
