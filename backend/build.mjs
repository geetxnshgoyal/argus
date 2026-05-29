// Bundles the server into dist/server.mjs so production needs only Node, this
// file and the web assets: no `npm install` on the server.
import { build } from 'esbuild';
import { cp, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  // pg optionally requires the native binding; we never use it.
  external: ['pg-native'],
  define: { __ARGUS_VERSION__: JSON.stringify(pkg.version) },
  // Some CJS dependencies call require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const webDist = new URL('../web/dist', import.meta.url);
if (existsSync(webDist)) {
  await cp(webDist, 'dist/web', { recursive: true });
  console.log('Bundled server + web assets into backend/dist/');
} else {
  console.log('Bundled server into backend/dist/ (web/dist not found; build the web app first to include it)');
}
