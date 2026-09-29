#!/usr/bin/env node
// Cuts a release with one version everywhere (app, server, web), then tags it.
// The tag makes GitHub build the Android APK (.github/workflows/android-apk.yml);
// pushing main makes Vercel deploy the server, which reports "<version>+<commit>".
//
//   pnpm release 0.0.6
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: pnpm release <major.minor.patch>, e.g. pnpm release 0.0.6');
  process.exit(2);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) {
  console.error('Commit or stash your changes first.');
  process.exit(1);
}
if (git('tag', '--list', `v${version}`)) {
  console.error(`v${version} already exists.`);
  process.exit(1);
}

for (const file of ['backend/package.json', 'web/package.json']) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  pkg.version = version;
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
// The app's build number (after "+") must grow with every release for the stores.
const pubspec = readFileSync('app/pubspec.yaml', 'utf8');
const build = Number(/^version: *[^+\n]*\+(\d+)/m.exec(pubspec)?.[1] ?? 0) + 1;
writeFileSync('app/pubspec.yaml', pubspec.replace(/^version: .*$/m, `version: ${version}+${build}`));

git('commit', '-am', `release: ${version}`);
git('tag', '-a', `v${version}`, '-m', `Argus v${version}`);
git('push', 'origin', 'HEAD');
git('push', 'origin', `v${version}`);
console.log(`Released v${version} (app build ${build}). GitHub is building the APK; Vercel is deploying the server.`);
