import { build } from 'esbuild';

export async function planningWorkerSource() {
  const result = await build({ entryPoints: ['src/features/expansion/planner.worker.ts'], bundle: true, write: false,
    format: 'iife', target: 'es2022', minify: true, metafile: true });
  return { source: result.outputFiles[0].text, inputs: Object.keys(result.metafile.inputs) };
}
export const planningWorkerPlugin = {
  name: 'planning-worker',
  setup(builder) {
    builder.onLoad({ filter: /background-planner\.ts$/ }, async ({ path }) => {
      const { readFile } = await import('node:fs/promises');
      const { source, inputs } = await planningWorkerSource();
      return { contents: `const __EXPANSION_WORKER__ = ${JSON.stringify(source)};\n${await readFile(path, 'utf8')}`,
        loader: 'ts', watchFiles: inputs };
    });
  },
};
