// 对象定义查看页（存储过程 / 函数 / 触发器 / 事件 / 序列 / 用户）
import { el, iconEl } from './util.js';
import { connLabel, connColor, setActiveTarget } from './state.js';
import { addTab } from './tabs.js';
import { toast } from './toast.js';

const KIND_LABELS = {
  PROCEDURE: '存储过程', FUNCTION: '函数', TRIGGER: '触发器',
  EVENT: '事件', SEQUENCE: '序列', USER: '用户',
};

/**
 * target: {connId, db, schema, kind, name, extra}
 */
export function openDefTab(target) {
  setActiveTarget(target, 'definition-tab');
  const tabId = `def:${target.connId}|${target.db || ''}|${target.kind}|${target.name}|${target.extra || ''}`;
  const tab = addTab({
    id: tabId,
    title: `${KIND_LABELS[target.kind] || target.kind} - ${target.name}`,
    icon: 'struct',
    color: connColor(target.connId),
    tooltip: `${connLabel(target.connId)} / ${target.db || ''} / ${target.name}`,
  });
  tab.setOnShow(() => setActiveTarget(target, 'definition-tab'));
  if (tab.pane.childElementCount) return tab;

  let ddlText = '';
  const body = el('div', { class: 'ddl-box', style: { margin: '10px', flex: '1', overflow: 'auto', whiteSpace: 'pre-wrap' } }, '加载中…');
  const toolbar = el('div', { class: 'pane-toolbar' },
    el('button', { class: 'pbtn', onClick: () => { navigator.clipboard.writeText(ddlText); toast.success('已复制'); } }, iconEl('copy'), '复制定义'),
    el('button', { class: 'pbtn', onClick: load }, iconEl('refresh'), '刷新'),
    el('span', { class: 'spring' }),
    el('span', { class: 'obj-path' },
      `${connLabel(target.connId)}${target.db ? ' › ' + target.db : ''}${target.schema ? ' › ' + target.schema : ''} › ${target.name}`));
  tab.pane.append(toolbar, body);

  async function load() {
    body.textContent = '加载中…';
    try {
      ddlText = await window.api.db.objectDdl(target.connId, {
        db: target.db, schema: target.schema, kind: target.kind, name: target.name, extra: target.extra,
      });
      body.textContent = ddlText || '(空)';
    } catch (e) {
      body.textContent = '加载失败: ' + e.message;
    }
  }
  load();
  return tab;
}
