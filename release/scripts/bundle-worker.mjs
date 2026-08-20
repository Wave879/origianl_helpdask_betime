#!/usr/bin/env node
/**
 * Bundle src/index.js → deploy/pages_bundle/_worker.js
 * Uses esbuild for fast, tree-shaken output compatible with Cloudflare Workers.
 *
 * Usage:
 *   node scripts/bundle-worker.mjs          — one-shot build
 *   node scripts/bundle-worker.mjs --watch  — watch mode (dev)
 */

import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const isWatch = process.argv.includes('--watch');

const config = {
  entryPoints: [path.join(ROOT, 'src/index.js')],
  bundle: true,
  outfile: path.join(ROOT, 'deploy/pages_bundle/_worker.js'),
  format: 'esm',
  target: 'es2022',
  platform: 'browser',  // Cloudflare Workers uses browser-like globals
  minify: !isWatch,
  sourcemap: isWatch ? 'inline' : false,
  // Mark Node built-ins as external (Workers runtime provides pg via nodejs_compat)
  external: ['pg', 'node:*', 'cloudflare:*'],
  define: {
    'process.env.NODE_ENV': isWatch ? '"development"' : '"production"',
  },
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await build({ ...config, minify: false });
  console.log('Watching for changes...');
} else {
  const result = await build(config);
  console.log('✓ Built → deploy/pages_bundle/_worker.js');
}
