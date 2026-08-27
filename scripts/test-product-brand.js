const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const text = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function testPackageIdentity() {
  const pkg = JSON.parse(text('package.json'));
  assert.strictEqual(pkg.name, 'dbpanda');
  assert.strictEqual(pkg.productName, 'DBPanda');
  assert.strictEqual(pkg.author, 'DBPanda');
  assert.strictEqual(pkg.build.appId, 'com.dbpanda.app');
  assert.strictEqual(pkg.build.productName, 'DBPanda');
  assert.strictEqual(pkg.build.nsis.shortcutName, 'DBPanda');
  assert.strictEqual(pkg.scripts['brand:test'], 'node scripts/test-brand-assets.js && node scripts/test-product-brand.js');
  assert.strictEqual(pkg.scripts['ui:test'], 'node scripts/test-dialog-layout.js');
  assert.strictEqual(pkg.scripts['types:test'], 'node scripts/test-db-types.js');
  assert.strictEqual(pkg.scripts['workspace:test'], 'node scripts/test-workspace.js');
  assert.strictEqual(pkg.scripts['core:test'], 'node scripts/test-step1.js');
  // verify 必须覆盖所有已注册的 *:test 脚本，外加 selftest 与 smoke。
  //
  // 这里刻意**不比对固定字符串**：原先写死整条 verify 链，导致每新增一个检查
  // 都会让本测试失败（v2.6.3 加 workflow:test 时就炸过一次），
  // 而失败原因与品牌校验毫无关系，很容易被误判成"改坏了"。
  // 改成按集合校验后，新增检查只要接进 verify 就自动通过；忘了接才会失败——
  // 那正是这条断言真正想守住的东西。
  const verifySteps = String(pkg.scripts.verify || '')
    .split('&&')
    .map((part) => part.trim().replace(/^npm run /, ''))
    .filter(Boolean);
  const registeredChecks = Object.keys(pkg.scripts).filter((name) => name.endsWith(':test'));
  for (const check of registeredChecks) {
    assert.ok(
      verifySteps.includes(check),
      `verify 未包含已注册的检查 ${check}：新增检查后需要接进 npm run verify`,
    );
  }
  for (const required of ['selftest', 'smoke']) {
    assert.ok(verifySteps.includes(required), `verify 必须包含 ${required}`);
  }
}

function testVisibleBrandCopy() {
  const files = [
    'src/renderer/index.html',
    'src/renderer/js/menubar.js',
    'src/renderer/js/app.js',
    'src/renderer/js/aiPanel.js',
    'src/main/ipc.js',
    'src/main/exporter.js',
    'src/main/sync.js',
    'src/main/transfer.js',
    'src/main/fileAccess.js',
    'src/main/db/clickhouse.js',
    'README.md',
    'LICENSE',
  ];
  const leftovers = files.filter((file) => /Datavia/.test(text(file)));
  assert.deepStrictEqual(leftovers, [], `Visible Datavia references remain in: ${leftovers.join(', ')}`);
  const main = text('src/main/main.js');
  assert.match(main, /const WINDOW_TITLE = `DBPanda v\$\{app\.getVersion\(\)\}`/);
  assert.match(main, /title:\s*WINDOW_TITLE/);
  assert.match(main, /page-title-updated/);
  assert.doesNotMatch(text('src/renderer/js/menubar.js'), /menu-brand/);
}

function testLegacyDataMigration() {
  const { migrateLegacyUserData } = require('../src/main/userDataMigration');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpanda-migration-'));
  try {
    const destination = path.join(temp, 'DBPanda');
    const datavia = path.join(temp, 'Datavia');
    const dbconnect = path.join(temp, 'DBConnect');
    fs.mkdirSync(destination);
    fs.mkdirSync(datavia);
    fs.mkdirSync(dbconnect);
    fs.writeFileSync(path.join(destination, 'history.json'), 'new-history');
    fs.writeFileSync(path.join(datavia, 'connections.json'), 'datavia-connections');
    fs.writeFileSync(path.join(datavia, 'Local State'), 'datavia-encryption-state');
    fs.writeFileSync(path.join(dbconnect, 'connections.json'), 'old-connections');
    fs.writeFileSync(path.join(dbconnect, 'Local State'), 'old-encryption-state');
    fs.writeFileSync(path.join(dbconnect, 'groups.json'), 'old-groups');

    migrateLegacyUserData(destination, [datavia, dbconnect]);

    assert.strictEqual(fs.readFileSync(path.join(destination, 'connections.json'), 'utf8'), 'datavia-connections');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'groups.json'), 'utf8'), 'old-groups');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'history.json'), 'utf8'), 'new-history');
    assert.strictEqual(fs.readFileSync(path.join(destination, 'Local State'), 'utf8'), 'datavia-encryption-state');

    // Repair an already-migrated profile only while its connection file is
    // still byte-for-byte identical to the legacy source.
    fs.writeFileSync(path.join(destination, 'Local State'), 'wrong-new-state');
    migrateLegacyUserData(destination, [datavia, dbconnect]);
    assert.strictEqual(fs.readFileSync(path.join(destination, 'Local State'), 'utf8'), 'datavia-encryption-state');
    fs.writeFileSync(path.join(destination, 'connections.json'), 'changed-in-dbpanda');
    fs.writeFileSync(path.join(destination, 'Local State'), 'current-state');
    migrateLegacyUserData(destination, [datavia, dbconnect]);
    assert.strictEqual(fs.readFileSync(path.join(destination, 'Local State'), 'utf8'), 'current-state');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * 对外下载链接必须是固定的。
 *
 * GitHub 的 releases/latest/download/<文件名> 只在**文件名不变**时才是一个长期链接，
 * 所以安装包产物名里不能再出现版本号——一旦有人把 ${version} 加回去，
 * 官网/群里发出去的链接就会在下一次发版时集体失效，而且不会有任何报错提醒。
 * 这里从 artifactName 推出真实文件名，再逐个核对发布流水线、校验脚本与 README 用的是同一个名字。
 */
function testStableDownloadName() {
  const pkg = JSON.parse(text('package.json'));
  const artifactName = pkg.build.win.artifactName;
  assert.ok(
    !/\$\{version\}/.test(artifactName),
    `build.win.artifactName 不能包含 \${version}（当前：${artifactName}）：`
    + '文件名带版本号会让 releases/latest/download 的固定下载链接每次发版失效',
  );
  const named = (ext) => artifactName
    .replace('${productName}', pkg.build.productName)
    .replace('${ext}', ext);
  const installer = named('exe');
  const portable = named('zip');

  const workflow = text('.github/workflows/release.yml');
  for (const file of [installer, portable]) {
    assert.ok(
      workflow.includes(`release/${file}`),
      `发布流水线未上传 release/${file}：产物名改了就要同步改 .github/workflows/release.yml`,
    );
  }
  assert.ok(
    !/release\/DBPanda-Setup-\$\{\{/.test(workflow),
    '发布流水线仍在按版本号拼产物名，与固定下载链接冲突',
  );

  const verifyScript = text('scripts/verify-windows-release.ps1');
  for (const file of [installer, portable]) {
    assert.ok(
      verifyScript.includes(`release\\${file}`),
      `release:verify 未检查 release\\${file}`,
    );
  }

  // README 里公布的就是用户实际点的链接，必须和产物名一致
  const readme = text('README.md');
  for (const file of [installer, portable]) {
    assert.ok(
      readme.includes(`releases/latest/download/${file}`),
      `README 的下载链接与产物名 ${file} 不一致`,
    );
  }
}

testPackageIdentity();
testStableDownloadName();
testVisibleBrandCopy();
testLegacyDataMigration();
console.log('DBPanda product identity, stable download name and legacy migration checks passed');
