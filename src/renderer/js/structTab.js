// 设计表（结构查看）标签页：列 / 索引 / DDL
import { el } from './util.js';
import { connLabel, connColor, setActiveTarget } from './state.js';
import { addTab } from './tabs.js';
import { toast } from './toast.js';

export function openStructTab(target) {
  setActiveTarget(target, 'structure-tab');
  const tabId = `struct:${target.connId}|${target.db}|${target.schema || ''}|${target.table}`;
  const tab = addTab({
    id: tabId,
    title: `设计 - ${target.table}`,
    icon: 'struct',
    color: connColor(target.connId),
    tooltip: `${connLabel(target.connId)} / ${target.db || ''} / ${target.table}`,
  });
  tab.setOnShow(() => setActiveTarget(target, 'structure-tab'));
  if (tab.pane.childElementCount) return tab;

  const body = el('div', { class: 'struct-pane' }, el('div', { style: { color: 'var(--text-muted)' } }, '加载中…'));
  tab.pane.append(body);

  (async () => {
    try {
      const info = await window.api.db.tableInfo(target.connId, {
        db: target.db, schema: target.schema, table: target.table,
      });
      body.innerHTML = '';

      // 列
      body.append(el('h3', {}, `栏位（${info.columns.length}）`));
      const colTable = el('table', { class: 'struct-table' },
        el('thead', {}, el('tr', {},
          el('th', { style: { width: '30px' } }, ''),
          el('th', {}, '名称'), el('th', {}, '类型'), el('th', {}, '允许 NULL'),
          el('th', {}, '默认值'), el('th', {}, '附加'), el('th', {}, '注释'))));
      const tb = el('tbody');
      for (const c of info.columns) {
        tb.append(el('tr', {},
          el('td', { class: 'pk-mark', title: c.key === 'PRI' ? '主键' : '' }, c.key === 'PRI' ? '🔑' : ''),
          el('td', { style: { fontWeight: c.key === 'PRI' ? '600' : '400' } }, c.name),
          el('td', { style: { fontFamily: 'var(--mono)' } }, c.type || ''),
          el('td', {}, c.nullable ? '是' : '否'),
          el('td', { style: { fontFamily: 'var(--mono)' } }, c.def === null || c.def === undefined ? '' : String(c.def)),
          el('td', {}, c.extra || ''),
          el('td', { style: { color: 'var(--text-muted)' } }, c.comment || '')));
      }
      colTable.append(tb);
      body.append(colTable);

      // 索引
      body.append(el('h3', {}, `索引（${info.indexes.length}）`));
      if (info.indexes.length) {
        const ixTable = el('table', { class: 'struct-table' },
          el('thead', {}, el('tr', {},
            el('th', {}, '名称'), el('th', {}, '栏位'), el('th', {}, '唯一'), el('th', {}, '主键'))));
        const ixb = el('tbody');
        for (const ix of info.indexes) {
          ixb.append(el('tr', {},
            el('td', {}, ix.name),
            el('td', { style: { fontFamily: 'var(--mono)' } }, (ix.columns && ix.columns.length) ? ix.columns.join(', ') : (ix.def || '')),
            el('td', {}, ix.unique ? '是' : ''),
            el('td', {}, ix.primary ? '是' : '')));
        }
        ixTable.append(ixb);
        body.append(ixTable);
      } else {
        body.append(el('div', { style: { color: 'var(--text-muted)', fontSize: '12.5px' } }, '（无索引）'));
      }

      // 外键
      try {
        const fks = await window.api.db.foreignKeys(target.connId, { db: target.db, schema: target.schema, table: target.table });
        if (fks && fks.length) {
          body.append(el('h3', {}, `外键（${fks.length}）`));
          const fkTable = el('table', { class: 'struct-table' },
            el('thead', {}, el('tr', {},
              el('th', {}, '名称'), el('th', {}, '本表栏位'), el('th', {}, '引用表'), el('th', {}, '引用栏位'))));
          const fkb = el('tbody');
          for (const fk of fks) {
            fkb.append(el('tr', {},
              el('td', {}, fk.name),
              el('td', { style: { fontFamily: 'var(--mono)' } }, fk.columns.join(', ')),
              el('td', { style: { fontFamily: 'var(--mono)' } }, (fk.refSchema ? fk.refSchema + '.' : '') + fk.refTable),
              el('td', { style: { fontFamily: 'var(--mono)' } }, fk.refColumns.join(', '))));
          }
          fkTable.append(fkb);
          body.append(fkTable);
        }
      } catch (e) { /* 不支持外键的库忽略 */ }

      // DDL
      body.append(el('h3', {}, 'DDL'));
      const ddlBox = el('div', { class: 'ddl-box' }, info.ddl || '（不可用）');
      body.append(ddlBox);
      body.append(el('div', { style: { marginTop: '8px' } },
        el('button', { class: 'btn', onClick: () => { navigator.clipboard.writeText(info.ddl || ''); toast.success('DDL 已复制'); } }, '复制 DDL')));
    } catch (e) {
      body.innerHTML = '';
      body.append(el('div', { style: { color: 'var(--danger)' } }, '加载失败: ' + e.message));
    }
  })();

  return tab;
}
