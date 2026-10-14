const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { profiles } = require('./release-profile');
const root = path.join(__dirname, '..');
const output = path.join(root, 'release');
function digest(file, algorithm, encoding) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
}
function validate(dir, id, version) {
  const profile = profiles[id];
  if (!profile) throw new Error(`Unknown profile ${id}`);
  for (const name of profile.files) {
    if (!fs.statSync(path.join(dir, name)).size) throw new Error(`Empty asset: ${name}`);
  }
  const manifest = yaml.load(fs.readFileSync(path.join(dir, profile.files.find(n => n.endsWith('.yml'))), 'utf8'));
  if (manifest.version !== version) throw new Error(`Version mismatch: ${id}`);
  // updater 清单只引用可自动更新的主包：Windows EXE、Linux 包、macOS ZIP。
  // Windows ZIP 和 macOS DMG 是下载分发包，不要求出现在 updater files 数组。
  const expected = profile.files.filter(n => /\.(exe|AppImage|deb)$/.test(n)
    || (profile.platform === 'darwin' && n.endsWith('.zip')));
  const allowed = profile.platform === 'darwin'
    ? profile.files.filter(n => /\.(dmg|zip)$/.test(n))
    : expected;
  const entries = manifest.files || [];
  for (const entry of entries) {
    if (!allowed.includes(entry.url)) throw new Error(`Wrong channel asset: ${entry.url}`);
    const file = path.join(dir, entry.url);
    if (entry.sha512 !== digest(file, 'sha512', 'base64') || entry.size !== fs.statSync(file).size) {
      throw new Error(`Invalid asset hash/size: ${entry.url}`);
    }
  }
  for (const name of expected) {
    if (!entries.some(entry => entry.url === name)) throw new Error(`Manifest missing ${name}`);
  }
  if (!expected.includes(manifest.path) || manifest.sha512 !== digest(path.join(dir, manifest.path), 'sha512', 'base64')) {
    throw new Error(`Invalid fallback path/hash: ${id}`);
  }
  return profile.files;
}
function main(mode, arg) {
  if (mode === 'stage') {
    const names = validate(output, arg, require('../package.json').version);
    const staged = path.join(output, 'staged');
    fs.mkdirSync(staged, { recursive: true });
    for (const name of names) fs.copyFileSync(path.join(output, name), path.join(staged, name));
    return;
  }
  if (mode !== 'publish' || !/^\d+\.\d+\.\d+$/.test(arg)) throw new Error('Expected stage profile or publish version');
  const names = Object.keys(profiles).flatMap(id => validate(output, id, arg));
  if (new Set(names).size !== names.length) throw new Error('Release asset name collision');
  const base = `https://github.com/hufafu1-cloud/dbconnect/releases/download/v${arg}/`;
  const downloads = Object.entries(profiles).map(([id, p]) => ({
    id, platform: p.platform, arch: p.arch, channel: p.channel,
    assets: p.files.filter(n => !/\.(yml|blockmap)$/.test(n)).map(name => ({ name, url: base + name, sha256: digest(path.join(output, name), 'sha256', 'hex') })),
  }));
  fs.writeFileSync(path.join(output, 'downloads.json'), JSON.stringify({ version: arg, downloads }, null, 2) + '\n');
  fs.writeFileSync(path.join(output, 'SHA256SUMS.txt'), names.map(name => `${digest(path.join(output, name), 'sha256', 'hex')}  ${name}`).join('\n') + '\n');
  const notes = fs.readFileSync(path.join(root, 'release-notes.md'), 'utf8');
  const section = notes.split(`## v${arg} 更新日志`)[1];
  const body = section ? section.split(/^## v/m)[0].trim() : `DBPanda v${arg}`;
  const links = downloads.map(p => `- ${p.id}: ${p.assets.map(a => `[${a.name}](${a.url})`).join(' / ')}`).join('\n');
  fs.writeFileSync(path.join(output, 'RELEASE-NOTES.md'), `${body}\n\n### 下载\n\n${links}\n\nWin7 为 Electron 22 遗留兼容版，运行时已停止安全维护，需在目标机器验收。Linux x64/ARM64 包不代表所有 UOS/麒麟版本认证，不支持龙芯 LoongArch。\n`);
}
if (require.main === module) main(process.argv[2], process.argv[3]);
module.exports = { validate };
