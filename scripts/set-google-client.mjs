// Stores a Google OAuth client in Vercel without anyone copying the secret by hand:
//   node scripts/set-google-client.mjs ~/Downloads/client_secret_XXXX.json
// Reads the JSON Google offers when you create a "Web application" client and sets
// OIDC_CLIENT_ID and OIDC_CLIENT_SECRET for Production (and, if backend/.env exists,
// for local development too). Nothing is printed except the client ID.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/set-google-client.mjs <client_secret_….json>');
  process.exit(2);
}
const json = JSON.parse(readFileSync(file, 'utf8'));
const c = json.web ?? json.installed;
if (!c?.client_id || !c?.client_secret) {
  console.error('That file is not a Google OAuth client (expected "web.client_id" and "web.client_secret").');
  process.exit(1);
}
for (const [name, value] of [['OIDC_CLIENT_ID', c.client_id], ['OIDC_CLIENT_SECRET', c.client_secret]]) {
  try {
    execFileSync('vercel', ['env', 'rm', name, 'production', '--yes'], { stdio: 'ignore' });
  } catch {
    // not set yet
  }
  execFileSync('vercel', ['env', 'add', name, 'production'], { input: value, stdio: ['pipe', 'ignore', 'inherit'] });
}
const envFile = new URL('../backend/.env', import.meta.url);
if (existsSync(envFile)) {
  const lines = readFileSync(envFile, 'utf8').split('\n').filter((l) => !/^OIDC_CLIENT_(ID|SECRET)=/.test(l));
  lines.push(`OIDC_CLIENT_ID=${c.client_id}`, `OIDC_CLIENT_SECRET=${c.client_secret}`);
  writeFileSync(envFile, lines.filter((l, i, a) => l !== '' || i < a.length - 1).join('\n') + '\n');
}
console.log(`Saved Google client ${c.client_id} to Vercel (Production)${existsSync(envFile) ? ' and backend/.env' : ''}. Redeploy to use it: vercel deploy --prod`);
