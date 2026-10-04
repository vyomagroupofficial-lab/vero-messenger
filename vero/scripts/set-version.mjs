// Stamps a release version into the app and desktop configs.
//   node scripts/set-version.mjs v1.2.3
// app.json: expo.version + android.versionCode; desktop/package.json: version.
import fs from 'node:fs';

const raw = process.argv[2] ?? '';
const m = raw.replace(/^refs\/tags\//, '').match(/^v?(\d+)\.(\d+)\.(\d+)$/);
if (!m) {
  console.log(`[set-version] "${raw}" is not a vX.Y.Z tag; keeping the versions in the repo.`);
  process.exit(0);
}
const version = `${m[1]}.${m[2]}.${m[3]}`;
const code = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);

const app = JSON.parse(fs.readFileSync('app.json', 'utf8'));
app.expo.version = version;
app.expo.android = { ...app.expo.android, versionCode: code };
fs.writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n');

const desk = JSON.parse(fs.readFileSync('desktop/package.json', 'utf8'));
desk.version = version;
fs.writeFileSync('desktop/package.json', JSON.stringify(desk, null, 2) + '\n');
console.log(`[set-version] ${version} (versionCode ${code})`);
