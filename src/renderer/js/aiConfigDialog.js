// AI 助手设置：配置 OpenAI 兼容大模型（接口地址 / API Key / 模型）
import { el, iconEl } from './util.js';
import { openModal, toast } from './toast.js';

const PRESETS = [
  { id: 'thunisoft', name: '万象 MaaS', baseUrl: 'https://llm.thunisoft.com/v1', model: 'GLM-5.2' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'moonshot', name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'qwen', name: '通义千问 (DashScope)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'ollama', name: 'Ollama (本地)', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder' },
  { id: 'custom', name: '自定义 (OpenAI 兼容)', baseUrl: '', model: '' },
];

export async function openAiConfigDialog(onSaved) {
  let cfg;
  try { cfg = await window.api.ai.getConfig(); } catch (e) { cfg = { provider: 'thunisoft', baseUrl: 'https://llm.thunisoft.com/v1', model: 'GLM-5.2', apiKey: '' }; }

  const providerSel = el('select', {}, ...PRESETS.map((p) => el('option', { value: p.id, selected: p.id === cfg.provider ? 'selected' : null }, p.name)));
  providerSel.value = PRESETS.some((p) => p.id === cfg.provider) ? cfg.provider : 'custom';
  const baseInput = el('input', { type: 'text', value: cfg.baseUrl || '', placeholder: 'https://api.deepseek.com/v1', spellcheck: false });
  const keyInput = el('input', { type: 'password', value: '', placeholder: cfg.hasApiKey ? '已安全保存；留空保持不变' : 'sk-...', spellcheck: false });
  let keyDirty = false;
  keyInput.addEventListener('input', () => { keyDirty = true; });
  const modelSel = el('select', { title: '从模型列表中选择' });
  const modelRefresh = el('button', { class: 'btn model-refresh', title: '重新获取模型列表', onClick: () => loadModels(false) }, iconEl('refresh'), '刷新');
  let modelItems = [];
  const showKey = el('button', { class: 'btn', tabIndex: -1, onClick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, '👁');
  const testResult = el('span', { class: 'test-result' }, '');

  providerSel.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === providerSel.value);
    if (p && p.id !== 'custom') {
      baseInput.value = p.baseUrl;
      modelSel.innerHTML = '';
      modelSel.append(el('option', { value: '', disabled: 'disabled', selected: 'selected' }, '正在获取模型列表…'));
      loadModels(true);
    }
  });

  function modelLabel(item) {
    const meta = [];
    if (item.contextLength) meta.push(`上下文 ${Number(item.contextLength).toLocaleString()}`);
    if (item.inputPrice !== null && item.inputPrice !== undefined) meta.push(`输入 ${item.inputPrice}`);
    if (item.outputPrice !== null && item.outputPrice !== undefined) meta.push(`输出 ${item.outputPrice}`);
    return meta.length ? `${item.id}（${meta.join(' · ')}）` : item.id;
  }

  function setModelValue(value) {
    const target = String(value || '');
    if (target && ![...modelSel.options].some((option) => option.value === target)) {
      modelSel.append(el('option', { value: target }, `${target}（当前）`));
    }
    modelSel.value = target;
  }

  function renderModels(items) {
    modelItems = Array.isArray(items) ? items : [];
    const current = modelSel.value || cfg.model || '';
    modelSel.innerHTML = '';
    if (!modelItems.length) {
      if (current) modelSel.append(el('option', { value: current }, `${current}（当前）`));
      else modelSel.append(el('option', { value: '' }, '请先获取模型列表'));
      setModelValue(current);
      return;
    }
    for (const item of modelItems) modelSel.append(el('option', { value: item.id }, modelLabel(item)));
    const currentExists = modelItems.some((item) => item.id === current);
    const preset = PRESETS.find((item) => item.id === providerSel.value);
    const preferred = preset && preset.model;
    const preferredExists = preferred && modelItems.some((item) => item.id === preferred);
    setModelValue(currentExists ? current : (preferredExists ? preferred : modelItems[0].id));
  }

  async function loadModels(silent = false) {
    const baseUrl = baseInput.value.trim();
    const apiKey = keyDirty ? keyInput.value.trim() : '';
    if (!baseUrl || (!apiKey && !cfg.hasApiKey)) {
      if (!silent) toast.error('请先填写 API Key 和接口地址');
      return;
    }
    modelRefresh.disabled = true;
    try {
      const result = await window.api.ai.listModels({
        provider: providerSel.value,
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
      });
      renderModels(result);
      if (!silent) toast.success(`已获取 ${Array.isArray(result) ? result.length : 0} 个模型`);
    } catch (e) {
      modelSel.innerHTML = '';
      modelSel.append(el('option', { value: '', disabled: 'disabled', selected: 'selected' }, '获取失败，请点击“刷新”重试'));
      if (!silent) toast.error('获取模型列表失败：' + e.message);
    } finally {
      modelRefresh.disabled = false;
    }
  }

  function collect() {
    const out = {
      provider: providerSel.value,
      baseUrl: baseInput.value.trim(),
      model: modelSel.value.trim(),
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.2,
    };
    if (keyDirty || !cfg.hasApiKey) out.apiKey = keyInput.value;
    return out;
  }

  const body = el('div', { class: 'form-grid' },
    el('label', {}, '服务商'), providerSel,
    el('label', {}, '接口地址'), baseInput,
    el('label', {}, 'API Key'), el('div', { class: 'row-flex' }, keyInput, showKey),
    el('label', {}, '模型'), el('div', { class: 'row-flex' }, modelSel, modelRefresh),
    el('label', {}, ''), el('div', { style: { fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6' } },
      'API Key 仅加密保存在本机。使用 AI 时，你输入的 SQL/问题及按需读取的表名、列名会发送到上方接口地址。'));

  const m = openModal({
    title: 'AI 助手设置',
    body,
    width: 540,
    buttons: [
      {
        label: '测试连接',
        onClick: () => {
          const c = collect();
          if (!c.apiKey && !cfg.hasApiKey) { toast.error('请填写 API Key'); return false; }
          testResult.className = 'test-result';
          testResult.textContent = '正在测试…';
          window.api.ai.test(c).then((r) => {
            testResult.className = 'test-result ok';
            testResult.textContent = `✔ 连通（模型 ${r.model}，回复「${r.reply}」）`;
          }).catch((e) => {
            testResult.className = 'test-result err';
            testResult.textContent = '✖ ' + e.message;
          });
          return false;
        },
      },
      { label: '取消' },
      {
        label: '保存', primary: true,
        onClick: () => {
          const c = collect();
          if (!c.baseUrl) { toast.error('请填写接口地址'); return false; }
          window.api.ai.saveConfig(c).then(() => {
            toast.success('AI 设置已保存');
            if (onSaved) onSaved(c);
          }).catch((e) => toast.error(e.message));
        },
      },
    ],
  });
  const foot = m.overlay.querySelector('.modal-foot');
  foot.insertBefore(testResult, foot.firstChild);
  renderModels([]);
  if (providerSel.value === 'thunisoft') setTimeout(() => loadModels(true), 30);
  setTimeout(() => keyInput.focus(), 30);
  return m;
}
