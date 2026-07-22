const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WIN_CODE_SIGN_VERSION = '2.6.0';
const WIN_CODE_SIGN_ARTIFACT = `winCodeSign-${WIN_CODE_SIGN_VERSION}`;

function createBuildEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    ELECTRON_BUILDER_DISABLE_BUILD_CACHE: 'true',
  };
}

function getBuilderArgs() {
  return ['--win', 'nsis', 'zip'];
}

function getWinCodeSignCachePaths(env = process.env) {
  const cacheBase = env.ELECTRON_BUILDER_CACHE
    || path.win32.join(env.LOCALAPPDATA || path.win32.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache');
  const cacheRoot = path.win32.join(cacheBase, 'winCodeSign');
  return {
    cacheRoot,
    archivePath: path.win32.join(cacheRoot, `${WIN_CODE_SIGN_ARTIFACT}.7z`),
    targetDir: path.win32.join(cacheRoot, WIN_CODE_SIGN_ARTIFACT),
  };
}

function getWinCodeSignUrl(env = process.env) {
  const mirror = env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_MIRROR
    || env.npm_config_electron_builder_binaries_mirror
    || env.ELECTRON_BUILDER_BINARIES_MIRROR
    || 'https://github.com/electron-userland/electron-builder-binaries/releases/download/';
  const customDir = env.NPM_CONFIG_ELECTRON_BUILDER_BINARIES_CUSTOM_DIR
    || env.npm_config_electron_builder_binaries_custom_dir
    || env.ELECTRON_BUILDER_BINARIES_CUSTOM_DIR
    || WIN_CODE_SIGN_ARTIFACT;
  return `${mirror.replace(/\/+$/, '')}/${customDir}/${WIN_CODE_SIGN_ARTIFACT}.7z`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${path.basename(command)} terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with code ${result.status}`);
}

function prepareWinCodeSignCache(env = process.env) {
  if (process.platform !== 'win32') return;
  const { appBuilderPath } = require('app-builder-bin');
  const { path7za } = require('7zip-bin');
  const paths = getWinCodeSignCachePaths(env);
  const signTool = path.win32.join(paths.targetDir, 'windows-10', 'x64', 'signtool.exe');
  if (fs.existsSync(signTool)) return;

  fs.mkdirSync(paths.cacheRoot, { recursive: true });
  if (!fs.existsSync(paths.archivePath)) {
    console.log(`Preparing Windows build tools: ${WIN_CODE_SIGN_ARTIFACT}`);
    run(appBuilderPath, ['download', '--url', getWinCodeSignUrl(env), '--output', paths.archivePath], { env });
  }
  fs.mkdirSync(paths.targetDir, { recursive: true });
  run(path7za, [
    'x', '-bd', '-y',
    '-x!darwin\\*',
    '-x!linux\\*',
    paths.archivePath,
    `-o${paths.targetDir}`,
  ], { env });
  if (!fs.existsSync(signTool)) throw new Error(`winCodeSign cache is incomplete: ${signTool}`);
}

function cleanReleaseOutput() {
  const releaseDir = path.join(__dirname, '..', 'release');
  fs.mkdirSync(releaseDir, { recursive: true });
  const keep = new Set();
  for (const name of fs.readdirSync(releaseDir)) {
    if (keep.has(name)) continue;
    // 发布目录只保存当前构建产物；旧安装包、旧 blockmap、旧 zip 和构建临时目录均可安全清理。
    if (/^DBPanda-Setup-\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\.exe(?:\.blockmap)?|\.zip)$/.test(name)
      || name === 'latest.yml' || name === 'builder-debug.yml' || name === 'win-unpacked') {
      fs.rmSync(path.join(releaseDir, name), { recursive: true, force: true });
    }
  }
}

function cleanReleaseTemp() {
  const releaseDir = path.join(__dirname, '..', 'release');
  for (const name of ['win-unpacked', 'builder-debug.yml', '__uninstaller-nsis-dbpanda.exe']) {
    fs.rmSync(path.join(releaseDir, name), { recursive: true, force: true });
  }
}

function buildRelease() {
  const cli = require.resolve('electron-builder/out/cli/cli.js');
  const env = createBuildEnv();
  cleanReleaseOutput();
  prepareWinCodeSignCache(env);
  const result = spawnSync(process.execPath, [cli, ...getBuilderArgs()], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`electron-builder terminated by ${result.signal}`);
  if (result.status === 0) cleanReleaseTemp();
  process.exitCode = result.status == null ? 1 : result.status;
}

if (require.main === module) buildRelease();

module.exports = {
  buildRelease,
  createBuildEnv,
  getBuilderArgs,
  getWinCodeSignCachePaths,
  getWinCodeSignUrl,
  prepareWinCodeSignCache,
  cleanReleaseOutput,
  cleanReleaseTemp,
};
