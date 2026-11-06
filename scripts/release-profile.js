// Run only in a disposable CI checkout: selects dependencies before npm ci.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const profiles = {
  'windows-x64': { platform: 'win32', arch: 'x64', channel: 'latest', files: ['DBPanda-Setup.exe', 'DBPanda-Setup.zip', 'DBPanda-Setup.exe.blockmap', 'latest.yml'] },
  'win7-x64': { platform: 'win32', arch: 'x64', channel: 'win7', files: ['DBPanda-Win7-x64-Setup.exe', 'DBPanda-Win7-x64-Setup.zip', 'DBPanda-Win7-x64-Setup.exe.blockmap', 'win7.yml'] },
  'linux-x64': { platform: 'linux', arch: 'x64', channel: 'latest', files: ['DBPanda-Linux-x86_64.AppImage', 'DBPanda-Linux-amd64.deb', 'latest-linux.yml'] },
  'linux-arm64': { platform: 'linux', arch: 'arm64', channel: 'latest', files: ['DBPanda-Linux-arm64.AppImage', 'DBPanda-Linux-arm64.deb', 'latest-linux-arm64.yml'] },
  'macos-x64': { platform: 'darwin', arch: 'x64', channel: 'latest', files: ['DBPanda-Mac-x64.dmg', 'DBPanda-Mac-x64.zip', 'latest-mac.yml'] },
  'macos-arm64': { platform: 'darwin', arch: 'arm64', channel: 'latest-arm64', files: ['DBPanda-Mac-arm64.dmg', 'DBPanda-Mac-arm64.zip', 'latest-arm64-mac.yml'] },
};
function prepare(id, version) {
  if (!profiles[id] || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected profile and stable x.y.z version');
  if (process.env.CI !== 'true') throw new Error('Use a disposable CI checkout to prepare a release profile');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  let lockPath = path.join(root, 'package-lock.json');
  if (id === 'win7-x64') {
    const legacy = JSON.parse(fs.readFileSync(path.join(root, 'build/win7/package.json')));
    pkg.dependencies = legacy.dependencies;
    pkg.devDependencies = legacy.devDependencies;
    pkg.overrides = legacy.overrides;
    lockPath = path.join(root, 'build/win7/package-lock.json');
  }
  const lock = JSON.parse(fs.readFileSync(lockPath));
  pkg.version = lock.version = lock.packages[''].version = version;
  pkg.releaseVariant = id;
  // Profile build uses its own native rebuild after npm ci.
  delete pkg.scripts.postinstall;
  delete lock.packages[''].hasInstallScript;
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
}
if (require.main === module) prepare(process.argv[2], process.argv[3]);
module.exports = { profiles, prepare };
