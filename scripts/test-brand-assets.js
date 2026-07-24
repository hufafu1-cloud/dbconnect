const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name));

function testPng() {
  const png = read('assets/icon.png');
  assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'icon.png must be a PNG');
  assert.strictEqual(png.readUInt32BE(16), 1024, 'icon.png width must be 1024');
  assert.strictEqual(png.readUInt32BE(20), 1024, 'icon.png height must be 1024');
}

function testIco() {
  const ico = read('assets/icon.ico');
  assert.strictEqual(ico.readUInt16LE(0), 0, 'ICO reserved field must be zero');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'ICO type must be icon');
  assert.strictEqual(ico.readUInt16LE(4), 9, 'ICO must contain nine Windows icon sizes');
  const sizes = [];
  for (let i = 0; i < 9; i++) {
    const width = ico[6 + i * 16] || 256;
    const height = ico[7 + i * 16] || 256;
    assert.strictEqual(width, height, `ICO entry ${i} must be square`);
    sizes.push(width);
  }
  assert.deepStrictEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
}

function testApprovedLogoSource() {
  const source = read('assets/dbpanda-logo-source.png');
  assert.deepStrictEqual([...source.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.strictEqual(source.readUInt32BE(16), 1254, 'approved DBPanda logo source width must remain 1254');
  assert.strictEqual(source.readUInt32BE(20), 1254, 'approved DBPanda logo source height must remain 1254');

  const { BADGE, decodePng, SOURCE_PATH } = require('./gen-icon');
  assert.strictEqual(path.basename(SOURCE_PATH), 'dbpanda-logo.png');
  assert.deepStrictEqual(BADGE, { cropX: 350, cropY: 150, cropSize: 550 });
  const transparent = decodePng(read('assets/dbpanda-logo.png'));
  assert.strictEqual(transparent.rgba[3], 0, 'DBPanda brand logo must have transparent corners');
}

function testBuildRelease() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, 'release version must be a valid semantic version');
  assert.strictEqual(packageJson.build.win.icon, 'assets/icon.ico');
  assert.notStrictEqual(packageJson.build.win.signAndEditExecutable, false, 'EXE resource editing must remain enabled');
  assert.strictEqual(packageJson.scripts.dist, 'node scripts/build-release.js');
  assert.strictEqual(packageJson.scripts.predist, 'npm run icon');
  assert.strictEqual(packageJson.scripts['release:verify'], 'powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-release.ps1');

  const { createBuildEnv, getBuilderArgs, getWinCodeSignCachePaths, getWinCodeSignUrl } = require('./build-release');
  const env = createBuildEnv({ SAMPLE: 'preserved' });
  assert.strictEqual(env.SAMPLE, 'preserved');
  assert.strictEqual(env.ELECTRON_BUILDER_DISABLE_BUILD_CACHE, 'true');
  assert.deepStrictEqual(getBuilderArgs(), ['--win', 'nsis', 'zip']);
  const cache = getWinCodeSignCachePaths({ ELECTRON_BUILDER_CACHE: 'C:\\builder-cache' });
  assert.strictEqual(cache.targetDir, path.win32.join('C:\\builder-cache', 'winCodeSign', 'winCodeSign-2.6.0'));
  assert.strictEqual(cache.archivePath, path.win32.join('C:\\builder-cache', 'winCodeSign', 'winCodeSign-2.6.0.7z'));
  assert.strictEqual(
    getWinCodeSignUrl({ ELECTRON_BUILDER_BINARIES_MIRROR: 'https://mirror.example/binaries/' }),
    'https://mirror.example/binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z',
  );
}

testPng();
testIco();
testApprovedLogoSource();
testBuildRelease();
console.log('Brand asset checks passed: approved DBPanda source + transparent lockup + 9-size ICO');
