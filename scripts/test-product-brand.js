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
  assert.strictEqual(pkg.scripts.verify, 'npm run brand:test && npm run ui:test && npm run selftest && npm run smoke');
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

testPackageIdentity();
testVisibleBrandCopy();
testLegacyDataMigration();
console.log('DBPanda product identity and legacy migration checks passed');
