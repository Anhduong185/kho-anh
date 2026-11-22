import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerRoot = path.resolve(__dirname, '..');
const outFile = path.join(workerRoot, 'dist', 'worker.mjs');

fs.mkdirSync(path.dirname(outFile), { recursive: true });

await build({
  entryPoints: [path.join(workerRoot, 'src', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  mainFields: ['module', 'main'],
  outfile: outFile,
  minify: true,
  sourcemap: false
});

const sizeKb = (fs.statSync(outFile).size / 1024).toFixed(2);
console.log(`Bundled Cloudflare Worker -> ${outFile} (${sizeKb} kB)`);
