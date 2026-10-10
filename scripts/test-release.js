const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const semver = require('semver');
const { profiles, prepare } = require('./release-profile');
const { validate } = require('./release-assets');
const { getUpdateChannel, getFeedOptions, validateUpdateInfo } = require('../src/main/updateConfig');
const { Provider } = require('electron-updater/out/providers/Provider');

assert.equal(getUpdateChannel({ releaseVariant: 'win7-x64' }), 'win7');
assert.equal(getUpdateChannel({ releaseVariant: 'windows-x64' }), 'latest');
assert.equal(getUpdateChannel({}), 'latest');
const saved = { ...process.env };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpanda-release-test-'));
try {
  for (const key of Object.keys(process.env)) if (key.startsWith('DBPANDA_UPDATE_')) delete process.env[key];
  assert.equal(getFeedOptions().url, 'https://github.com/hufafu1-cloud/dbconnect/releases/latest/download/');
  process.env.DBPANDA_UPDATE_URL = 'https://mirror.example/dbpanda';
  assert.equal(getFeedOptions().url, 'https://mirror.example/dbpanda/');
  process.env.CI = 'false';
  assert.throws(() => prepare('win7-x64', '2.9.0'), /disposable/);
  assert.throws(() => prepare('unknown', '2.9.0'));
  assert.throws(() => prepare('windows-x64', 'bad'));
  const version = '9.9.9';
  for (const [id, p] of Object.entries(profiles)) {
    process.env.TEST_UPDATER_ARCH = p.arch;
    const provider = new Provider({ platform: p.platform });
    const manifestName = provider.getCustomChannelName(p.channel) + '.yml';
    assert(p.files.includes(manifestName), `Updater cannot find ${manifestName}`);
    const dir = path.join(tmp, id);
    fs.mkdirSync(dir);
    for (const file of p.files) fs.writeFileSync(path.join(dir, file), `test asset ${file}`);
    const files = p.files.filter(f => /\.(exe|deb|AppImage)$/.test(f)).map(url => {
      const data = fs.readFileSync(path.join(dir, url));
      return { url, size: data.length, sha512: crypto.createHash('sha512').update(data).digest('base64') };
    });
    const info = { version, files, path: files[0].url, sha512: files[0].sha512 };
    const manifestPath = path.join(dir, manifestName);
    fs.writeFileSync(manifestPath, yaml.dump(info));
    assert.deepEqual(validate(dir, id, version), p.files);
    validateUpdateInfo(info, { releaseVariant: id }, p.platform, p.arch);
    assert.throws(() => validate(dir, id, '1.0.0'), /Version mismatch/);
    assert.throws(() => validateUpdateInfo({ files: [{ url: '../other.exe' }] }, { releaseVariant: id }, p.platform, p.arch));
    fs.appendFileSync(path.join(dir, files[0].url), 'corrupt');
    assert.throws(() => validate(dir, id, version), /hash/);
  }
  assert.throws(() => validateUpdateInfo({ files: [{ url: 'DBPanda-Setup.exe' }] }, { releaseVariant: 'win7-x64' }, 'win32', 'x64'));
  assert.throws(() => validateUpdateInfo({ files: [{ url: 'DBPanda-Linux-x64.deb' }] }, {}, 'linux', 'arm64'));
  const legacy = require('../build/win7/package.json');
  const lock = require('../build/win7/package-lock.json');
  assert.deepEqual(lock.packages[''].dependencies, legacy.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, legacy.devDependencies);
  assert.equal(legacy.devDependencies.electron, '22.3.27');
  assert.equal(legacy.dependencies['call-bind-apply-helpers'], '1.0.2');
  assert(lock.packages['node_modules/call-bind-apply-helpers'], 'Legacy lock must contain call-bind-apply-helpers');
  for (const [name, dep] of Object.entries(lock.packages)) {
    assert(!dep.link, `Unexpected local dependency: ${name}`);
    if (name && !dep.dev && dep.engines && dep.engines.node) {
      assert(semver.satisfies('16.17.1', dep.engines.node), `Legacy runtime incompatible: ${name} ${dep.version}`);
    }
  }
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/release.yml'), 'utf8'));
  assert.deepEqual(workflow.jobs.build.strategy.matrix.include.map(p => p.profile).sort(), Object.keys(profiles).sort());
  assert.equal(workflow.jobs.publish.needs, 'build');
  console.log('Release tests passed: four profiles, provider channels, hashes, isolation, legacy dependency engines, workflow matrix.');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  // Only remove the temporary fixture directory this test created.
  fs.rmSync(tmp, { recursive: true, force: true });
}
