// Builds Argus for Vercel with the Build Output API (ADR-0020):
//   .vercel/output/static/            the web app and classroom display (built by `pnpm --filter web build`)
//   .vercel/output/functions/api.func the whole API as one bundled Node 24 function
//   .vercel/output/config.json        routing, security headers, the daily cron
// Run from the repository root via `pnpm build:vercel` (Vercel's build command).
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const out = new URL('.vercel/output/', root);
const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const webDist = new URL('web/dist/', root);
if (!existsSync(webDist)) throw new Error('web/dist is missing: run `pnpm --filter web build` first');

await rm(out, { recursive: true, force: true });
const fn = new URL('functions/api.func/', out);
await mkdir(fn, { recursive: true });

await build({
  entryPoints: [new URL('./src/vercel.ts', import.meta.url).pathname],
  outfile: new URL('index.mjs', fn).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: 'linked',
  // pg optionally requires the native binding; we never use it.
  external: ['pg-native'],
  define: { __ARGUS_VERSION__: JSON.stringify(`${pkg.version}+${(process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7)}`) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await writeFile(new URL('package.json', fn), JSON.stringify({ type: 'module' }));
await writeFile(
  new URL('.vc-config.json', fn),
  JSON.stringify({
    runtime: 'nodejs24.x',
    handler: 'index.mjs',
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    supportsResponseStreaming: true,
    maxDuration: 60,
    // Singapore: next to the Neon database region closest to India.
    regions: [process.env.ARGUS_VERCEL_REGION ?? 'sin1'],
  }),
);

await cp(webDist, new URL('static/', out), { recursive: true });

// Same headers the long-running server adds to web pages (backend/src/app.ts).
const pageHeaders = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
await writeFile(
  new URL('config.json', out),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { src: '^/(?!v1/)(.*)$', headers: pageHeaders, continue: true },
        { src: '^/v1/(.*)$', dest: '/api' },
        { handle: 'filesystem' },
        { src: '^/display(/.*)?$', dest: '/display.html' },
        { src: '^/(.*)$', dest: '/index.html' },
      ],
      // Daily at 00:15 India time (18:45 UTC). Requests also run due jobs (backend/src/jobs.ts).
      crons: [{ path: '/v1/internal/cron', schedule: '45 18 * * *' }],
    },
    null,
    2,
  ),
);
console.log('Built .vercel/output (static web + api function)');
