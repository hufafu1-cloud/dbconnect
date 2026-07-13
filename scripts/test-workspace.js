const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function main() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'workspace.js'), 'utf8');
  const workspace = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

  class MemoryStorage {
    constructor() { this.values = new Map(); }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
  }

  const storage = new MemoryStorage();
  const snapshot = {
    activeId: 'table:连接一|测试 库||订单 明细',
    context: {
      openConnectionIds: ['连接-id-1', 'connection-id-2'],
      activeTarget: { connId: '连接-id-1', db: '测试 库' },
    },
    tabs: [
      { id: 'query-7', type: 'query', state: { target: { connId: '连接-id-1', db: '测试 库' }, sql: 'select 1;' } },
      { id: 'table:连接一|测试 库||订单 明细', type: 'table', state: { target: { connId: '连接-id-1', db: '测试 库', table: '订单 明细' } } },
    ],
  };
  assert.strictEqual(workspace.writeWorkspace(snapshot, storage), true);
  const loaded = workspace.readWorkspace(storage);
  assert.strictEqual(loaded.version, 1);
  assert.ok(loaded.savedAt > 0);
  assert.strictEqual(loaded.activeId, snapshot.activeId);
  assert.deepStrictEqual(loaded.tabs.map((item) => item.id), snapshot.tabs.map((item) => item.id));
  assert.deepStrictEqual(loaded.context.openConnectionIds, snapshot.context.openConnectionIds);
  assert.strictEqual(loaded.tabs[0].state.sql, 'select 1;');

  const unsafe = JSON.parse(`{
    "version": 1,
    "activeId": "objects",
    "context": {"openConnectionIds":["ok"], "__proto__":{"polluted":true}},
    "tabs": [
      {"id":"bad\\u0000id","type":"query","state":{"sql":"bad"}},
      {"id":"__proto__","type":"query","state":{"sql":"bad"}},
      {"id":"query-2","type":"Query!","state":{"sql":"bad"}},
      {"id":"query-3","type":"query","state":{"sql":"ok", "constructor":{"polluted":true}}},
      {"id":"query-3","type":"query","state":{"sql":"duplicate"}}
    ]
  }`);
  const safe = workspace.normalizeWorkspace(unsafe);
  assert.deepStrictEqual(safe.tabs.map((item) => item.id), ['query-3']);
  assert.strictEqual(safe.tabs[0].state.sql, 'ok');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(safe.tabs[0].state, 'constructor'), false);
  assert.strictEqual(Object.prototype.polluted, undefined);

  const oversized = workspace.normalizeWorkspace({
    version: 1,
    tabs: [{ id: 'query-big', type: 'query', state: { sql: 'x'.repeat(1024 * 1024 + 1) } }],
  });
  assert.strictEqual(oversized.tabs.length, 1);
  assert.strictEqual(oversized.tabs[0].state.sql.length, 1024 * 1024 + 1);
  const longPrefix = `design:${'c'.repeat(300)}`;
  const longIds = [`${longPrefix}|table-a`, `${longPrefix}|table-b`];
  const longIdentity = workspace.normalizeWorkspace({
    version: 1,
    activeId: longIds[1],
    tabs: longIds.map((id) => ({ id, type: 'design', state: { model: { columns: [] } } })),
  });
  assert.deepStrictEqual(longIdentity.tabs.map((item) => item.id), longIds);
  assert.strictEqual(longIdentity.activeId, longIds[1]);
  assert.strictEqual(workspace.normalizeWorkspace({
    version: 1, tabs: [{ id: 'x'.repeat(8193), type: 'query', state: { sql: 'x' } }],
  }).tabs.length, 0);

  storage.setItem(workspace.WORKSPACE_STORAGE_KEY, '{broken json');
  assert.deepStrictEqual(workspace.readWorkspace(storage).tabs, []);
  assert.strictEqual(workspace.clearWorkspace(storage), true);
  assert.strictEqual(storage.getItem(workspace.WORKSPACE_STORAGE_KEY), null);

  const unavailable = {
    getItem() { throw new Error('unavailable'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('unavailable'); },
  };
  assert.deepStrictEqual(workspace.readWorkspace(unavailable).tabs, []);
  assert.strictEqual(workspace.writeWorkspace(snapshot, unavailable), false);
  assert.strictEqual(workspace.clearWorkspace(unavailable), false);
  globalThis.window = {
    api: { workspace: { read: async () => { throw new Error('sharing violation'); } } },
  };
  await assert.rejects(() => workspace.loadWorkspace(), /停用自动恢复和自动保存/);
  delete globalThis.window;

  const tabsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'tabs.js'), 'utf8');
  assert.match(tabsSource, /setRecovery\(type, getState\)/);
  assert.match(tabsSource, /touchRecovery:\s*scheduleWorkspacePersist/);
  assert.match(tabsSource, /export async function restoreWorkspaceTabs/);
  assert.match(tabsSource, /deferredWorkspaceEntries/);
  assert.match(tabsSource, /saveWorkspace/);
  assert.match(tabsSource, /setWorkspaceContextProvider/);
  assert.match(tabsSource, /beforeunload/);
  assert.match(tabsSource, /workspaceRestoring/);
  assert.match(tabsSource, /lastEnqueuedWorkspaceSignature/);
  assert.match(tabsSource, /syncSeq\(entry\.id\)/);
  assert.doesNotMatch(tabsSource, /if \(tabs\.has\(id\)[\s\S]{0,100}deferredWorkspaceEntries\.delete\(id\)/);
  const querySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'queryTab.js'), 'utf8');
  const tableSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'tableTab.js'), 'utf8');
  const designSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'designTab.js'), 'utf8');
  const objectsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'objectsTab.js'), 'utf8');
  assert.match(querySource, /setRecovery\('query'/);
  assert.match(querySource, /sql:\s*cm\.getValue\(\)/);
  assert.match(querySource, /target:\s*connId/);
  assert.match(querySource, /\(opts && opts\.saved\) \? initialText : ''/);
  assert.match(querySource, /restoreState\.savedPath\s*\?\s*''/);
  assert.match(querySource, /cm\.getValue\(\) !== savedText \|\| transactionState !== 'idle'/);
  assert.match(querySource, /dbUnavailable/);
  assert.match(querySource, /splitterHeight:\s*Math\.round\(splitterHeight \|\| 240\)/);
  assert.match(tableSource, /setRecovery\('table'/);
  assert.match(tableSource, /grid\.isDirty\(\)\s*\?\s*null/);
  assert.match(designSource, /setRecovery\('design'/);
  assert.match(designSource, /model:\s*JSON\.parse/);
  assert.match(designSource, /original:\s*original\s*\?/);
  assert.match(designSource, /dirty,/);
  assert.match(designSource, /tab\.workspaceReady/);
  assert.match(designSource, /let isNew = !target\.table/);
  assert.match(designSource, /target\.table = model\.table;\s*isNew = false;/);
  assert.match(designSource, /A clean existing design is only navigation state/);
  assert.match(designSource, /恢复草稿与当前结构需核对/);
  assert.match(designSource, /c\.editSafe !== false/);
  assert.match(objectsSource, /loadGeneration/);
  assert.match(objectsSource, /selected = null;\s*items = \[\];\s*if \(listEl\) renderPlaceholder\('正在加载…'\)/);
  assert.match(objectsSource, /_context:\s*itemContext/);
  for (const temporary of ['explainTab.js', 'procTab.js', 'aiPanel.js']) {
    const temporarySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', temporary), 'utf8');
    assert.doesNotMatch(temporarySource, /setRecovery\(/, `${temporary} must remain transient`);
  }
  const workspaceStoreSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'workspaceStore.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'), 'utf8');
  const ipcSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
  assert.match(workspaceStoreSource, /fs\.promises\.rename\(tmp, target\)/);
  assert.match(workspaceStoreSource, /MAX_WORKSPACE_BYTES\s*=\s*128\s*\*\s*1024\s*\*\s*1024/);
  assert.match(preloadSource, /workspace:\s*\{/);
  assert.match(mainSource, /app:close-ack/);
  assert.match(mainSource, /app:cancel-close/);
  assert.match(mainSource, /!pendingClose\.acknowledged/);
  assert.match(appSource, /ackClose\(requestId\)/);
  assert.match(appSource, /cancelClose\(requestId\)/);
  assert.match(appSource, /recoverableDraft \? null : false/);
  assert.doesNotMatch(ipcSource, /list(?:ForeignKeys|Constraints)\([^\n]+\.catch\(\(\) => \[\]\)/);
  assert.match(ipcSource, /listReferencingForeignKeys/);
  assert.match(ipcSource, /metadataComplete === false/);

  class FakeClassList {
    constructor(initial = '') { this.names = new Set(String(initial).split(/\s+/).filter(Boolean)); }
    toggle(name, force) {
      const enabled = force === undefined ? !this.names.has(name) : !!force;
      if (enabled) this.names.add(name); else this.names.delete(name);
      return enabled;
    }
    contains(name) { return this.names.has(name); }
  }
  class FakeNode {
    constructor(tag, attrs = {}) {
      this.tag = tag;
      this.children = [];
      this.parent = null;
      this.style = attrs.style || {};
      this.classList = new FakeClassList(attrs.class || '');
      this.title = attrs.title || '';
      this.textContent = '';
    }
    append(...nodes) {
      for (const node of nodes.flat()) {
        if (node === null || node === undefined) continue;
        const child = node instanceof FakeNode ? node : new FakeNode('#text');
        if (!(node instanceof FakeNode)) child.textContent = String(node);
        if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
        child.parent = this;
        this.children.push(child);
      }
    }
    addEventListener() {}
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
    get childElementCount() { return this.children.length; }
  }

  async function loadTabsModule(testStorage, overrides = {}) {
    const roots = { '#tabbar': new FakeNode('div'), '#tabpanes': new FakeNode('div') };
    const timers = new Map();
    let timerNo = 0;
    globalThis.localStorage = testStorage;
    globalThis.window = {
      setInterval() { return 1; },
      setTimeout(fn) { const id = ++timerNo; timers.set(id, fn); return id; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener() {},
    };
    globalThis.__tabsTest = {
      $: (selector) => roots[selector],
      el: (tag, attrs = {}, ...children) => {
        const node = new FakeNode(tag, attrs);
        node.append(...children);
        return node;
      },
      iconEl: () => new FakeNode('svg'),
      confirmDialog: async () => true,
      toast: { error() {} },
      loadWorkspace: overrides.loadWorkspace || (async () => workspace.readWorkspace(testStorage)),
      saveWorkspace: overrides.saveWorkspace || (async (value) => {
        if (!workspace.writeWorkspace(value, testStorage)) throw new Error('save failed');
        return true;
      }),
    };
    const transformed = tabsSource
      .replace("import { $, el, iconEl } from './util.js';", 'const { $, el, iconEl } = globalThis.__tabsTest;')
      .replace("import { confirmDialog, toast } from './toast.js';", 'const { confirmDialog, toast } = globalThis.__tabsTest;')
      .replace("import { showMenu } from './contextmenu.js';", 'const showMenu = () => {};')
      .replace("import { loadWorkspace, saveWorkspace } from './workspace.js';", 'const { loadWorkspace, saveWorkspace } = globalThis.__tabsTest;')
      + `\n// tabs-test-${Date.now()}-${Math.random()}`;
    const module = await import(`data:text/javascript;base64,${Buffer.from(transformed).toString('base64')}`);
    const flushTimers = async () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const fn of pending) fn();
      await module.persistWorkspaceNow();
    };
    return { module, roots, flushTimers };
  }

  const tabStorage = new MemoryStorage();
  const firstTabs = await loadTabsModule(tabStorage);
  firstTabs.module.addTab({ id: 'objects', title: '对象', permanent: true });
  const query = firstTabs.module.addTab({ id: 'query-9', title: '草稿' });
  query.setRecovery('query', () => ({ sql: 'select 42', target: { connId: 'c1', db: 'db1' } }));
  const table = firstTabs.module.addTab({ id: 'table:c1|db1||订单 表', title: '订单 表' });
  table.setRecovery('table', () => ({ target: { connId: 'c1', db: 'db1', table: '订单 表' } }));
  firstTabs.module.setWorkspaceContextProvider(() => ({ openConnectionIds: ['c1'] }));
  firstTabs.module.startWorkspacePersistence();
  await firstTabs.flushTimers();
  let tabSnapshot = workspace.readWorkspace(tabStorage);
  assert.deepStrictEqual(tabSnapshot.tabs.map((item) => item.id), ['query-9', 'table:c1|db1||订单 表']);
  assert.strictEqual(tabSnapshot.activeId, 'table:c1|db1||订单 表');
  assert.deepStrictEqual(tabSnapshot.context.openConnectionIds, ['c1']);
  assert.match(firstTabs.module.uid('query'), /^query-(?:1[0-9]|[2-9][0-9]+)$/);
  const malformedSequence = firstTabs.module.addTab({ id: `query-${'9'.repeat(80)}`, title: 'malformed sequence' });
  assert.strictEqual(firstTabs.module.uid('query'), 'query-11');
  await firstTabs.module.closeTab(malformedSequence.id, true);
  await firstTabs.module.closeTab(table.id, true);
  await firstTabs.flushTimers();
  tabSnapshot = workspace.readWorkspace(tabStorage);
  assert.deepStrictEqual(tabSnapshot.tabs.map((item) => item.id), ['query-9']);
  assert.strictEqual(tabSnapshot.activeId, 'query-9');

  workspace.writeWorkspace({
    activeId: 'query-7',
    context: { openConnectionIds: ['c1'] },
    tabs: snapshot.tabs,
  }, tabStorage);
  const restoredTabs = await loadTabsModule(tabStorage);
  restoredTabs.module.addTab({ id: 'objects', title: '对象', permanent: true });
  const result = await restoredTabs.module.restoreWorkspaceTabs((entry) => {
    const handle = restoredTabs.module.addTab({ id: entry.id, title: entry.type });
    handle.setRecovery(entry.type, () => entry.state);
    return handle;
  });
  assert.strictEqual(result.restored, 2);
  assert.deepStrictEqual(restoredTabs.module.getWorkspaceSnapshot().tabs.map((item) => item.id), snapshot.tabs.map((item) => item.id));
  assert.strictEqual(restoredTabs.module.getActiveTab().id, 'query-7');

  // A temporarily unavailable connection must keep the original tab snapshot,
  // then restore it later without requiring an app restart.
  const deferredStorage = new MemoryStorage();
  workspace.writeWorkspace({
    activeId: 'design-new-1',
    context: { openConnectionIds: ['c1'] },
    tabs: [{
      id: 'design-new-1', type: 'design',
      state: { target: { connId: 'c1', db: 'db1', table: 'orders' }, model: { columns: [{ name: 'id' }] }, dirty: true },
    }],
  }, deferredStorage);
  const deferredTabs = await loadTabsModule(deferredStorage);
  deferredTabs.module.addTab({ id: 'objects', title: '对象', permanent: true });
  let connectionAvailable = false;
  const restoreDeferred = (entry) => {
    if (!connectionAvailable) return null;
    const handle = deferredTabs.module.addTab({ id: entry.id, title: '设计' });
    handle.setRecovery(entry.type, () => entry.state);
    return handle;
  };
  const deferredResult = await deferredTabs.module.restoreWorkspaceTabs(restoreDeferred);
  assert.strictEqual(deferredResult.restored, 0);
  assert.strictEqual(deferredResult.deferred, 1);
  assert.strictEqual(deferredTabs.module.uid('design-new'), 'design-new-2');
  await deferredTabs.module.persistWorkspaceNow();
  assert.deepStrictEqual(workspace.readWorkspace(deferredStorage).tabs.map((item) => item.id), ['design-new-1']);
  connectionAvailable = true;
  const retryResult = await deferredTabs.module.retryDeferredWorkspaceTabs(restoreDeferred);
  assert.strictEqual(retryResult.restored, 1);
  assert.strictEqual(retryResult.deferred, 0);
  assert.strictEqual(deferredTabs.module.getActiveTab().id, 'design-new-1');
  assert.strictEqual(deferredTabs.module.getWorkspaceSnapshot().tabs[0].state.dirty, true);

  // A completed snapshot A, queued B, then current state A again must finish
  // with A on disk. Close callers await the same tail rather than returning
  // while B can still overwrite it.
  const raceStorage = new MemoryStorage();
  const writes = [];
  let draftSql = 'A';
  let releaseB;
  let markBStarted;
  const bStarted = new Promise((resolve) => { markBStarted = resolve; });
  const bGate = new Promise((resolve) => { releaseB = resolve; });
  const raceTabs = await loadTabsModule(raceStorage, {
    saveWorkspace: async (value) => {
      const sql = value.tabs[0] && value.tabs[0].state.sql;
      writes.push(sql);
      if (sql === 'B') { markBStarted(); await bGate; }
      if (!workspace.writeWorkspace(value, raceStorage)) throw new Error('save failed');
      return true;
    },
  });
  raceTabs.module.addTab({ id: 'objects', title: '对象', permanent: true });
  const raceQuery = raceTabs.module.addTab({ id: 'query-1', title: 'race' });
  raceQuery.setRecovery('query', () => ({ sql: draftSql }));
  raceTabs.module.startWorkspacePersistence();
  await raceTabs.module.persistWorkspaceNow();
  draftSql = 'B';
  const writingB = raceTabs.module.persistWorkspaceNow();
  await bStarted;
  draftSql = 'A';
  const closingOnA = raceTabs.module.persistWorkspaceNow();
  releaseB();
  assert.strictEqual(await writingB, true);
  assert.strictEqual(await closingOnA, true);
  assert.deepStrictEqual(writes, ['A', 'B', 'A']);
  assert.strictEqual(workspace.readWorkspace(raceStorage).tabs[0].state.sql, 'A');

  console.log('Workspace recovery checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
