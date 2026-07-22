const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// cpu-features is an optional ssh2 optimization. It has no Electron prebuild
// for some toolchains, while ssh2 already falls back safely when it is absent.
// Hide it only while Electron dependencies are rebuilt so required modules such
// as better-sqlite3 still get rebuilt for Electron.
function temporarilyHideCpuFeatures(projectDir) {
  const modulesDir = path.join(projectDir, 'node_modules');
  const source = path.join(modulesDir, 'cpu-features');
  const hidden = path.join(modulesDir, 'cpu-features.disabled-during-rebuild');

  if (!fs.existsSync(source)) return () => {};
  if (fs.existsSync(hidden)) {
    throw new Error(`Cannot rebuild dependencies because ${hidden} already exists`);
  }

  fs.renameSync(source, hidden);
  return () => {
    if (fs.existsSync(hidden) && !fs.existsSync(source)) fs.renameSync(hidden, source);
  };
}

function installAppDeps(projectDir = path.join(__dirname, '..')) {
  const restoreCpuFeatures = temporarilyHideCpuFeatures(projectDir);
  let result;
  try {
    result = spawnSync(process.execPath, [
      require.resolve('electron-builder/out/cli/cli.js'),
      'install-app-deps',
    ], {
      cwd: projectDir,
      stdio: 'inherit',
    });
  } finally {
    restoreCpuFeatures();
  }

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`install-app-deps terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`install-app-deps exited with code ${result.status}`);
}

if (require.main === module) installAppDeps();

module.exports = { installAppDeps, temporarilyHideCpuFeatures };
