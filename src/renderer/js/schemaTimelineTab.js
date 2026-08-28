// Schema 版本时光机（路线图 v2.8.0）
//
// 左边是被记录过的表，中间是那张表的版本时间线，右边是选中两版之间的差异。
//
// 三处刻意的设计：
//
// 1. **默认选中「上一版 → 最新版」**，因为九成的使用场景是「刚出事，看看最近改了什么」。
//    要看更早的直接点时间线上的两个点。
//
// 2. **迁移与回滚脚本并排给出**，而不是只给迁移。结构改动的价值一半在
//    「怎么改过去」，另一半在「改错了怎么退回来」——后者才是深夜要用的那一半。
//
// 3. **时间轴上标的是「观察时间」而不是「变更时间」**，并且在界面上写明白。
//    这个功能记录的是本工具观察到的历史：改完又在下次查看前改回去，
//    中间那一版就没有记录。说清楚比假装精确重要。
import { el, iconEl, fmtCount } from './util.js';
import { state, getActiveTarget, connLabel } from './state.js';
import { addTab, uid } from './tabs.js';
import { toast, confirmDialog, cellViewer } from './toast.js';
import { t } from './i18n.js';

const TAB_ID = 'schema-timeline';

const KIND_COLOR = {
  add: 'add', remove: 'remove', type: 'type', rename: 'type',
  null: 'type', default: 'type', pk: 'type', comment: 'minor',
  index: 'minor', fk: 'minor', create: 'add', drop: 'remove',
};

function fmtTime(ms) {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 列表里的时间：当天只显示时分，其余显示月-日。完整时间戳放 title。 */
function fmtShort(ms) {
  const d = new Date(Number(ms) || 0);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export async function openSchemaTimelineTab(preset) {
  const tab = addTab({
    id: TAB_ID, title: t('结构时光机'), icon: 'history',
    tooltip: t('表结构的历史版本、任意两版的迁移与回滚脚本'),
  });
  if (tab.pane.childElementCount) {
    if (tab._reload) await tab._reload(preset);
    return tab;
  }
  tab.pane.classList.add('schema-pane');

  let allEntries = [];        // 全部记录
  let entries = [];           // 过滤后、真正渲染的
  let scopeConnId = '';       // '' 表示全部连接
  let scopeInitialized = false;
  let current = null;      // {id, table, versions:[...]}
  let fromIndex = 0;
  let toIndex = 0;
  let comparison = null;

  const listHost = el('div', { class: 'schema-list' });
  const bodyHost = el('div', { class: 'schema-body' });
  const usageEl = el('span', { class: 'undo-usage' });
  const scanStatus = el('span', { class: 'schema-scan-status' });
  // 范围默认收在「当前连接」：在案件码库里干活却看到另一个库的表，
  // 只会让人以为记错了。全部连接仍然一键可见，但不该是默认。
  const scopeSel = el('select', { class: 'schema-scope' });
  scopeSel.addEventListener('change', () => {
    scopeConnId = scopeSel.value;
    applyFilter();
  });
  const searchInput = el('input', {
    type: 'text', class: 'schema-search', spellcheck: false, placeholder: t('搜索表名…'),
  });
  searchInput.addEventListener('input', () => applyFilter());
  const btnScanTable = el('button', {
    class: 'pbtn', disabled: true, onClick: () => rescan('table'),
    title: t('读取当前选中这张表的结构，与上次记录比对。别的客户端改过结构时用它收进来。'),
  }, iconEl('struct'), t('重新扫描此表'));

  /**
   * 主动扫描：把库里当前的结构读一遍，与已记录的比对。
   *
   * 时光机平时只读本地记录、从不查库，所以**别的客户端改的结构它不知道**。
   * 这个按钮就是那条补丁：用它把外部改动收进来。
   * 刻意不做后台自动轮询——读几百张表的元数据在真实的库上不便宜。
   */
  /**
   * 「扫描整个库」要扫哪个库？
   *
   * **绝不能从已有记录里取。** 一张表都还没记录过的时候，正是最需要这个按钮的时候——
   * 拿历史记录当目标来源会让空列表和空列表互相锁死（第一版就是这么写错的）。
   * 所以按这个顺序找：选中的表 → 左侧树/当前标签页的活动目标 → 唯一一个打开的连接。
   */
  function scanTarget(scope) {
    if (scope === 'table') return current;
    // 整库扫描优先跟随**左侧树当前所在的库**，而不是列表里恰好选中的那一行：
    // 「我在案件码里点扫描整个库」扫的必须是案件码，哪怕右边正显示着另一个库的表。
    const active = getActiveTarget({ requireOpen: true, requireDb: true });
    if (active) {
      return { connId: active.connId, connName: connLabel(active.connId), db: active.db, schema: active.schema || null };
    }
    if (current) return current;
    const ids = [...state.open.keys()];
    if (ids.length === 1) {
      const oc = state.open.get(ids[0]);
      const db = (oc && oc.databases && oc.databases[0]) || null;
      if (db) return { connId: ids[0], connName: connLabel(ids[0]), db, schema: null };
    }
    return null;
  }

  async function rescan(scope) {
    const source = scanTarget(scope);
    if (!source) {
      toast.info(scope === 'table'
        ? t('请先在左侧选中一张表')
        : t('请先在左侧连接树里点开要扫描的数据库，再点「扫描整个库」'));
      return;
    }
    if (!state.open.has(source.connId)) {
      toast.info(t('连接「{name}」尚未打开，无法读取当前结构', { name: source.connName || source.connId }));
      return;
    }
    const token = uid('schema-scan');
    const off = window.api.schema.onProgress((p) => {
      scanStatus.textContent = t('扫描中 {done}/{total}：{table}', {
        done: p.done, total: p.total, table: p.table || '',
      });
    }, token);
    try {
      const result = await window.api.schema.rescan({
        connId: source.connId, db: source.db, schema: source.schema,
        table: scope === 'table' ? source.table : null,
        token,
      });
      const where = `${source.connName || source.connId}${source.db ? ' / ' + source.db : ''}`;
      const parts = [t('{where}：已扫描 {n} 张表', { where, n: fmtCount(result.scanned) })];
      if (result.changed) parts.push(t('{n} 张有变化', { n: result.changed }));
      if (result.added) parts.push(t('其中 {n} 张是首次记录', { n: result.added }));
      if (!result.changed) parts.push(t('结构与上次记录一致'));
      if (result.failures.length) parts.push(t('{n} 张读不到（权限或锁）', { n: result.failures.length }));
      toast[result.changed ? 'success' : 'info'](parts.join('，'));
      if (result.added && result.changed === result.added) {
        toast.info(t('首次记录只能建立基准：这一版之前的历史无从得知，'
          + '要看出「改了什么」需要至少两版。'), 8000);
      }
      // 扫完把范围切到刚扫的连接，否则新记录落在别的范围里，用户以为没扫上
      scopeConnId = source.connId;
      scopeInitialized = true;
      await reload({ connId: source.connId, db: source.db, schema: source.schema, table: source.table });
    } catch (error) {
      toast.error(t('扫描失败：') + (error && error.message ? error.message : error));
    } finally {
      off();
      scanStatus.textContent = '';
    }
  }

  /** 把全量记录按「连接范围 + 表名关键字」过滤成真正渲染的那一份 */
  function applyFilter() {
    const keyword = searchInput.value.trim().toLowerCase();
    entries = allEntries.filter((item) => (
      (!scopeConnId || item.connId === scopeConnId)
      && (!keyword || String(item.table || '').toLowerCase().includes(keyword))
    ));
    renderList();
    // 选中的表被过滤掉了就把右侧一起清掉，免得左右对不上
    if (current && !entries.some((item) => item.id === current.id)) {
      current = null;
      comparison = null;
      renderBody();
    }
  }

  /**
   * 刷新范围下拉。
   *
   * **当前所在的连接即使一条记录都没有，也必须出现在选项里并且默认选中。**
   * 只列「已有记录的连接」看着合理，实际后果是：你刚接上一个新库、正在它里面干活，
   * 时光机却把另一个库的表摊开给你看，而且下拉里连你这个库的名字都没有——
   * 完全无从下手。0 条记录恰恰是最需要看到「这里还没有记录，去扫一下」的时候。
   */
  function renderScope() {
    const counts = new Map();
    for (const item of allEntries) {
      counts.set(item.connId, (counts.get(item.connId) || 0) + 1);
    }
    const active = getActiveTarget({ requireOpen: true });
    if (active && !counts.has(active.connId)) counts.set(active.connId, 0);
    scopeSel.innerHTML = '';
    scopeSel.append(el('option', { value: '' }, t('全部连接（{n}）', { n: allEntries.length })));
    for (const [connId, count] of counts) {
      const label = connLabel(connId) || connId;
      scopeSel.append(el('option', { value: connId }, `${label}（${count}）`));
    }
    if (!scopeInitialized) {
      scopeInitialized = true;
      if (active) scopeConnId = active.connId;
    }
    if (scopeConnId && !counts.has(scopeConnId)) scopeConnId = '';
    scopeSel.value = scopeConnId;
  }

  async function reload(focus) {
    try {
      const result = await window.api.schema.list({});
      if (!result.available) {
        listHost.innerHTML = '';
        listHost.append(el('div', { class: 'undo-empty' },
          t('系统安全存储不可用，结构历史未启用。'),
          el('div', { class: 'undo-empty-hint' },
            t('结构快照与后悔药共用同一套加密存储；无法加密时不会写入磁盘。'))));
        usageEl.textContent = '';
        return;
      }
      allEntries = result.entries || [];
      // focus 指到哪个连接就先把范围切过去，否则「在树里点某张表 → 打开时光机」
      // 会因为默认范围不对而看起来什么都没有
      if (focus && focus.connId && allEntries.some((item) => item.connId === focus.connId)) {
        scopeConnId = focus.connId;
        scopeInitialized = true;
      }
      renderScope();
      applyFilter();
      const usage = result.usage || { entries: 0, bytes: 0 };
      usageEl.textContent = t('{n} 张表 · 占用 {size}', {
        n: fmtCount(usage.entries), size: fmtBytes(usage.bytes),
      });
      if (!result.enabled) {
        usageEl.textContent += t('（记录已在选项中关闭）');
      }
      const want = focus && entries.find((item) => item.connId === focus.connId
        && item.db === focus.db && (item.schema || '') === (focus.schema || '')
        && item.table === focus.table);
      if (want) await select(want.id);
      else if (!current && entries.length) await select(entries[0].id);
      else renderBody();
    } catch (error) {
      toast.error(t('读取结构历史失败：') + ((error && error.message) || error));
    }
  }
  tab._reload = reload;

  function connLabelOf(entry) {
    const conn = state.connections.find((c) => c.id === entry.connId);
    return (conn && conn.name) || entry.connName || entry.connId || '';
  }

  function renderList() {
    listHost.innerHTML = '';
    if (!entries.length && allEntries.length) {
      const keyword = searchInput.value.trim();
      const scopedName = scopeConnId ? (connLabel(scopeConnId) || scopeConnId) : '';
      const scopeEmpty = scopeConnId && !keyword
        && !allEntries.some((item) => item.connId === scopeConnId);
      listHost.append(el('div', { class: 'undo-empty' },
        scopeEmpty
          ? t('「{name}」还没有记录过任何表结构', { name: scopedName })
          : t('当前范围里没有匹配的表'),
        el('div', { class: 'undo-empty-hint' },
          scopeEmpty
            ? t('点上方「扫描整个库」给它建立第一版基准，之后的结构改动就都能追踪了。'
              + '别的连接已经记录了 {n} 张表，可以把范围切到「全部连接」查看。', { n: allEntries.length })
            : t('已记录 {n} 张表，但都不在这个连接 / 关键字范围内。'
              + '清空搜索框，或把范围切到「全部连接」。', { n: allEntries.length }))));
      return;
    }
    if (!entries.length) {
      listHost.append(el('div', { class: 'undo-empty' },
        t('还没有记录到任何表结构。'),
        el('div', { class: 'undo-empty-hint' },
          t('两种情况会自动记一版：在查询编辑器里执行 DDL（ALTER / CREATE / DROP TABLE 等），'
            + '或者打开一张表的「设计表」/「查看定义」。'
            + '后者顺带也会记下别的客户端做过的改动。'))));
      return;
    }
    // 按「连接 / 库 / 模式」分组。扫完一个库之后每一行都在重复同样的连接名和库名，
    // 那是纯噪音——真正要看的是表名。分组之后这三项每组只出现一次，
    // 每行也从「折行成两行」压回一行。
    const groups = new Map();
    for (const entry of entries) {
      const key = JSON.stringify([entry.connId, entry.db || '', entry.schema || '']);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    for (const items of groups.values()) {
      const head = items[0];
      const place = `${head.db || ''}${head.schema ? ' / ' + head.schema : ''}`;
      listHost.append(el('div', { class: 'schema-group' },
        el('span', { class: 'schema-group-conn', title: connLabelOf(head) }, connLabelOf(head)),
        el('span', { class: 'schema-group-db', title: place }, place),
        el('span', { class: 'spring' }),
        el('span', { class: 'schema-group-count' }, String(items.length))));
      for (const entry of items) {
        listHost.append(el('div', {
          class: 'schema-item' + (current && current.id === entry.id ? ' active' : '')
            + (entry.dropped ? ' dropped' : ''),
          onClick: () => select(entry.id),
        },
        el('span', { class: 'schema-item-table', title: entry.table }, entry.table),
        entry.dropped ? el('span', { class: 'schema-drop-tag' }, t('已删除')) : null,
        el('span', { class: 'spring' }),
        el('span', {
          class: 'schema-item-count' + (entry.versions > 1 ? ' has-history' : ''),
          title: entry.versions > 1
            ? t('有 {n} 版，可以对比出改了什么', { n: entry.versions })
            : t('只有 1 版，是基准；再有变化才比得出来'),
        }, t('{n} 版', { n: entry.versions })),
        el('span', { class: 'schema-item-time', title: fmtTime(entry.lastAt) }, fmtShort(entry.lastAt)),
        el('button', {
          class: 'schema-item-del', title: t('删除这张表的历史'),
          onClick: (e) => { e.stopPropagation(); removeOne(entry); },
        }, '✕')));
      }
    }
  }

  async function select(id) {
    try {
      current = await window.api.schema.timeline(id);
      const n = current.versions.length;
      // 九成场景是「刚出事，看看最近改了什么」，所以默认就选最近两版
      fromIndex = Math.max(0, n - 2);
      toIndex = n - 1;
      renderList();
      await refreshCompare();
    } catch (error) {
      current = null;
      comparison = null;
      renderList();
      renderBody((error && error.message) || String(error));
    }
  }

  async function refreshCompare() {
    if (!current || current.versions.length < 1) { comparison = null; renderBody(); return; }
    if (fromIndex === toIndex) { comparison = null; renderBody(); return; }
    try {
      comparison = await window.api.schema.compare(current.id, fromIndex, toIndex);
    } catch (error) {
      comparison = null;
      renderBody((error && error.message) || String(error));
      return;
    }
    renderBody();
  }

  function renderTimeline() {
    const rail = el('div', { class: 'schema-rail' });
    current.versions.forEach((version, index) => {
      const role = index === fromIndex ? ' from' : (index === toIndex ? ' to' : '');
      const inRange = index > Math.min(fromIndex, toIndex) && index < Math.max(fromIndex, toIndex);
      rail.append(el('button', {
        class: 'schema-node' + role + (inRange ? ' between' : '') + (version.dropped ? ' dropped' : ''),
        title: t('{time}　点击设为起点，Shift+点击设为终点', { time: fmtTime(version.at) }),
        onClick: (e) => {
          if (e.shiftKey) toIndex = index;
          else fromIndex = index;
          if (fromIndex > toIndex) { const x = fromIndex; fromIndex = toIndex; toIndex = x; }
          void refreshCompare();
        },
      },
      el('span', { class: 'schema-node-dot' }),
      el('span', { class: 'schema-node-time' }, fmtTime(version.at)),
      el('span', { class: 'schema-node-sum' }, version.dropped
        ? t('表已删除')
        : t('{n} 列', { n: version.summary ? version.summary.columns : 0 }))));
    });
    return el('div', { class: 'schema-timeline' },
      el('div', { class: 'schema-timeline-head' },
        el('b', {}, t('版本时间线')),
        el('span', { class: 'schema-hint' },
          t('标的是「观察时间」：本工具每次读到结构就比一次，改完又在下次查看前改回去的话，中间那一版不会有记录'))),
      rail);
  }

  function renderChanges() {
    if (!comparison) return null;
    if (!comparison.changes.length) {
      return el('div', { class: 'schema-changes' }, el('span', { class: 'schema-none' }, t('这两版之间结构没有变化')));
    }
    return el('div', { class: 'schema-changes' },
      ...comparison.changes.map((item) =>
        el('span', { class: 'schema-change ' + (KIND_COLOR[item.kind] || 'minor') }, item.text)));
  }

  function renderScript(title, sqls, error, direction) {
    const body = error
      ? el('div', { class: 'schema-script-error' }, error)
      : el('pre', { class: 'schema-script-body' },
        sqls.length ? sqls.map((sql) => sql.replace(/;\s*$/, '') + ';').join('\n') : t('（无需任何语句）'));
    return el('div', { class: 'schema-script' },
      el('div', { class: 'schema-script-head' },
        el('b', {}, title),
        el('span', { class: 'spring' }),
        el('button', {
          class: 'pbtn', disabled: !!error || !sqls.length,
          onClick: () => {
            navigator.clipboard.writeText(sqls.map((sql) => sql.replace(/;\s*$/, '') + ';').join('\n'));
            toast.success(t('已复制'));
          },
        }, iconEl('copy'), t('复制')),
        el('button', {
          class: 'pbtn', disabled: !!error || !sqls.length,
          onClick: (e) => exportMenu(e, direction),
        }, iconEl('exportIcon'), t('导出…'))),
      body);
  }

  function exportMenu(e, direction) {
    void (async () => {
      const { showMenu } = await import('./contextmenu.js');
      showMenu(e.clientX, e.clientY, [
        { label: t('Flyway 迁移文件（.sql）'), icon: 'exportIcon', onClick: () => saveScript('flyway', direction) },
        { label: t('Liquibase changelog（.xml）'), icon: 'exportIcon', onClick: () => saveScript('liquibase', direction) },
      ]);
    })();
  }

  async function saveScript(format, direction) {
    if (!comparison) return;
    try {
      const built = await window.api.schema.exportScript(current.id, fromIndex, toIndex, format, direction);
      const file = await window.api.dlg.saveFile({
        title: t('导出迁移脚本'),
        defaultPath: built.fileName,
        filters: format === 'liquibase'
          ? [{ name: 'XML', extensions: ['xml'] }]
          : [{ name: 'SQL', extensions: ['sql'] }],
      });
      if (!file) return;
      await window.api.file.write(file, built.text);
      toast.success(t('已导出 {name}', { name: built.fileName })
        + t('　放进你自己的迁移目录即可，本工具不联网托管'));
    } catch (error) {
      toast.error(t('导出失败：') + ((error && error.message) || error));
    }
  }

  function renderBody(errorText) {
    // 没选中表时「重新扫描此表」无从谈起；「扫描整个库」始终可用——
    // 一张表都没记录过的时候正是最需要它的时候。
    btnScanTable.disabled = !current;
    bodyHost.innerHTML = '';
    if (errorText) {
      bodyHost.append(el('div', { class: 'undo-empty' },
        t('无法读取这张表的历史'), el('div', { class: 'undo-empty-hint' }, errorText)));
      return;
    }
    if (!current) {
      bodyHost.append(el('div', { class: 'undo-empty' }, t('选择左侧的一张表查看它的结构历史')));
      return;
    }
    bodyHost.append(el('div', { class: 'schema-head' },
      el('div', { class: 'schema-head-title' }, current.table,
        el('span', { class: 'schema-head-sub' },
          `${current.connName || ''} · ${current.db || ''}${current.schema ? ' / ' + current.schema : ''}`)),
      el('button', {
        class: 'pbtn',
        onClick: () => cellViewer(t('该版本的完整结构'),
          JSON.stringify(current.versions[toIndex], null, 2), null),
      }, iconEl('info'), t('查看该版结构'))));
    bodyHost.append(renderTimeline());
    if (current.versions.length < 2) {
      bodyHost.append(el('div', { class: 'schema-single' },
        t('只有一版，还没有可对比的历史。这张表的结构下次发生变化时会自动记一版。')));
      return;
    }
    if (fromIndex === toIndex) {
      bodyHost.append(el('div', { class: 'schema-single' }, t('起点和终点是同一版，请在时间线上选两个不同的点')));
      return;
    }
    if (!comparison) return;
    bodyHost.append(el('div', { class: 'schema-range' },
      t('对比 {a} → {b}', { a: fmtTime(comparison.from.at), b: fmtTime(comparison.to.at) })));
    const changes = renderChanges();
    if (changes) bodyHost.append(changes);
    if (comparison.warnings.length) {
      bodyHost.append(el('div', { class: 'schema-warn' },
        iconEl('info'), el('span', {}, comparison.warnings.join('；'))));
    }
    bodyHost.append(el('div', { class: 'schema-scripts' },
      renderScript(t('迁移脚本（{a} → {b}）', { a: fromIndex + 1, b: toIndex + 1 }),
        comparison.migration, comparison.migrationError, 'migration'),
      renderScript(t('回滚脚本（{b} → {a}）', { a: fromIndex + 1, b: toIndex + 1 }),
        comparison.rollback, comparison.rollbackError, 'rollback')));
  }

  async function removeOne(entry) {
    const ok = await confirmDialog(t('删除结构历史'),
      t('将删除 {table} 的全部 {n} 版历史，删除后无法恢复。确定吗？',
        { table: entry.table, n: entry.versions }),
      { danger: true, okLabel: t('删除') });
    if (!ok) return;
    await window.api.schema.remove(entry.id).catch(() => {});
    if (current && current.id === entry.id) { current = null; comparison = null; }
    await reload();
  }

  async function clearAll() {
    const ok = await confirmDialog(t('清空结构历史'),
      t('将删除全部 {n} 张表的结构历史。确定吗？', { n: entries.length }),
      { danger: true, okLabel: t('全部清空') });
    if (!ok) return;
    const n = await window.api.schema.clear().catch(() => 0);
    current = null;
    comparison = null;
    await reload();
    toast.success(t('已清空 {n} 张表的历史', { n }));
  }

  tab.pane.append(
    el('div', { class: 'pane-toolbar' },
      el('button', { class: 'pbtn', onClick: () => reload() }, iconEl('refresh'), t('刷新')),
      scopeSel,
      searchInput,
      el('span', { class: 'sep' }),
      btnScanTable,
      el('button', {
        class: 'pbtn', onClick: () => rescan('db'),
        title: t('读取整个库的结构，顺带发现还没被记录过的表。表多时会慢。'),
      }, iconEl('database'), t('扫描整个库')),
      scanStatus,
      el('span', { class: 'spring' }),
      usageEl,
      el('button', { class: 'pbtn danger', onClick: clearAll }, iconEl('trash'), t('全部清空'))),
    el('div', { class: 'schema-split' }, listHost, bodyHost),
  );
  tab.setRecovery('schema-timeline', () => ({}));
  // 演示/冒烟用：把范围重置成未初始化，好重演「首次打开」时的默认收拢行为
  tab._resetScope = () => { scopeInitialized = false; scopeConnId = ''; };
  tab._reload = reload;

  renderBody();
  await reload(preset);
  return tab;
}
