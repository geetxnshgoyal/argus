// Turns on phone notifications (ADR-0025) from the two files the Firebase console gives you:
//   node scripts/set-firebase.mjs ~/Downloads/google-services.json ~/Downloads/<project>-firebase-adminsdk-….json
//
// 1. google-services.json: writes the Android app's Firebase settings to
//    app/android/app/src/main/res/values/firebase.xml (git-ignored), which Firebase reads at start-up.
//    GitHub builds do the same from the GOOGLE_SERVICES_JSON_B64 repository secret.
// 2. The service account key (optional, secret): stores it on Vercel as FCM_SERVICE_ACCOUNT for
//    Production, so the server can send notifications. It is never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const PACKAGE = 'app.argus.argus';
const [servicesFile, keyFile] = process.argv.slice(2);
if (!servicesFile) {
  console.error('Usage: node scripts/set-firebase.mjs <google-services.json> [<firebase-adminsdk key .json>]');
  process.exit(2);
}

const services = JSON.parse(readFileSync(servicesFile, 'utf8'));
const client = services.client?.find((c) => c.client_info?.android_client_info?.package_name === PACKAGE);
if (!services.project_info || !client) {
  console.error(`${servicesFile} has no Android app "${PACKAGE}". In Firebase, add an Android app with that package name and download its google-services.json.`);
  process.exit(1);
}
const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const values = {
  google_app_id: client.client_info.mobilesdk_app_id,
  gcm_defaultSenderId: services.project_info.project_number,
  google_api_key: client.api_key?.[0]?.current_key,
  project_id: services.project_info.project_id,
  ...(services.project_info.storage_bucket ? { google_storage_bucket: services.project_info.storage_bucket } : {}),
};
const xml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Firebase settings for phone notifications (ADR-0025), written by scripts/set-firebase.mjs. Not committed. -->
<resources>
${Object.entries(values)
  .map(([k, v]) => `    <string name="${k}" translatable="false">${esc(v)}</string>`)
  .join('\n')}
</resources>
`;
writeFileSync(new URL('../app/android/app/src/main/res/values/firebase.xml', import.meta.url), xml);
if (!keyFile) {
  console.log(`Firebase project ${values.project_id}: Android settings written.`);
  process.exit(0);
}

const key = JSON.parse(readFileSync(keyFile, 'utf8'));
if (key.type !== 'service_account' || !key.private_key || !key.client_email) {
  console.error(`${keyFile} is not a Firebase service account key (Project settings → Service accounts → Generate new private key).`);
  process.exit(1);
}
if (key.project_id !== values.project_id) {
  console.error(`The key is for project "${key.project_id}" but google-services.json is for "${values.project_id}".`);
  process.exit(1);
}
try {
  execFileSync('vercel', ['env', 'rm', 'FCM_SERVICE_ACCOUNT', 'production', '--yes'], { stdio: 'ignore' });
} catch {
  // not set yet
}
execFileSync('vercel', ['env', 'add', 'FCM_SERVICE_ACCOUNT', 'production'], {
  input: Buffer.from(JSON.stringify(key)).toString('base64'),
  stdio: ['pipe', 'ignore', 'inherit'],
});
console.log(`Firebase project ${values.project_id}: Android settings written to app/android/app/src/main/res/values/firebase.xml, server key saved to Vercel (Production).`);
console.log('Next: redeploy the server and rebuild the Android app.');
