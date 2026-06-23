// One command for local development: `pnpm dev`
// Starts the local Postgres (no Docker), the API (auto-restarts on change)
// and the web app with hot reload. Ctrl-C stops everything except Postgres
// (stop it with `pnpm db:stop`).
import { spawn, spawnSync } from 'node:child_process';

const DB_PORT = process.env.ARGUS_DEV_DB_PORT ?? '55432';

const db = spawnSync('sh', ['scripts/dev-db.sh', 'start'], { stdio: 'inherit' });
if (db.status !== 0) {
  console.error('Could not start the dev database. Is Postgres 16+ installed? (brew install postgresql@18)');
  process.exit(1);
}

const env = {
  ...process.env,
  ARGUS_ENV: 'dev',
  DATABASE_URL: process.env.DATABASE_URL ?? `postgres://argus@localhost:${DB_PORT}/argus`,
  ARGUS_PORT: '8080',
  // Dev-only sign-in without Google (refused by the server outside ARGUS_ENV=dev).
  ARGUS_DEV_LOGIN: process.env.ARGUS_DEV_LOGIN ?? 'true',
  OIDC_HOSTED_DOMAIN: process.env.OIDC_HOSTED_DOMAIN ?? 'svyasa-sas.edu.in',
  // Let phones/emulators on this machine's network reach the API in dev.
  ARGUS_HOST: process.env.ARGUS_HOST ?? '0.0.0.0',
};

const colors = { api: '\x1b[36m', web: '\x1b[35m' };
const children = [];

function run(name, args) {
  const child = spawn('pnpm', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = `${colors[name]}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${prefix}exited with code ${code}; stopping dev environment`);
      stop(1);
    }
  });
  children.push(child);
}

let stopping = false;
function stop(code = 0) {
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

run('api', ['--filter', 'backend', 'dev']);
run('web', ['--filter', 'web', 'dev']);

console.log(`
  Argus dev environment
  ─────────────────────
  Web app:     http://localhost:5173
  Display:     http://localhost:5173/display
  API health:  http://localhost:8080/v1/health
  Database:    postgres://argus@localhost:${DB_PORT}/argus
`);
