// AI 客户端：对接 OpenAI 兼容的大模型接口（DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / Ollama 等）
// 仅用全局 fetch（Electron 主进程自带 undici）。

/** 由 baseUrl 推导 chat/completions 地址 */
function buildUrl(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('未配置 AI 接口地址');
  if (/\/chat\/completions$/i.test(b)) return b;
  return b + '/chat/completions';
}

/** 由 OpenAI 兼容 Base URL 推导公司模型列表接口。 */
function buildModelsUrl(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('未配置 AI 接口地址');
  let parsed;
  try { parsed = new URL(b); } catch (e) { throw new Error('AI 接口地址不是合法 URL'); }
  return `${parsed.origin}/api/v1/models`;
}

/** 解析一行 SSE，返回增量文本（无内容返回 ''；[DONE] 返回 null） */
function parseSSELine(line) {
  const t = line.trim();
  if (!t.startsWith('data:')) return '';
  const data = t.slice(5).trim();
  if (data === '[DONE]') return null;
  try {
    const j = JSON.parse(data);
    const c = j.choices && j.choices[0];
    return (c && ((c.delta && c.delta.content) || (c.message && c.message.content))) || '';
  } catch (e) {
    return '';
  }
}

function headers(cfg) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` };
}

/** 流式对话。onDelta(textChunk) 回调；返回完整文本 */
async function chat(cfg, messages, { onDelta, signal } = {}) {
  if (!cfg || !cfg.apiKey) throw new Error('尚未配置 AI API Key，请先在「AI 助手设置」中填写');
  const url = buildUrl(cfg.baseUrl);
  const model = await resolveModel(cfg);
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : 0.2,
    }),
    signal,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch (e) { /* ignore */ }
    throw new Error(`AI 接口返回 ${res.status}：${detail.slice(0, 400) || res.statusText}`);
  }
  let full = '';
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const delta = parseSSELine(line);
      if (delta === null) continue;
      if (delta) { full += delta; if (onDelta) onDelta(delta); }
    }
  }
  return full;
}

/** 测试配置：发一条极短的非流式请求，确认连通与鉴权 */
async function test(cfg) {
  if (!cfg || !cfg.apiKey) throw new Error('请先填写 API Key');
  const url = buildUrl(cfg.baseUrl);
  const model = await resolveModel(cfg);
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '回复两个字：你好' }],
      stream: false,
      max_tokens: 16,
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`接口返回 ${res.status}：${txt.slice(0, 400) || res.statusText}`);
  let j = {};
  try { j = JSON.parse(txt); } catch (e) { throw new Error('返回不是合法 JSON：' + txt.slice(0, 200)); }
  const reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  return { model: j.model || model, reply: String(reply).slice(0, 60) };
}

async function resolveModel(cfg) {
  const configured = String(cfg && cfg.model || '').trim();
  if (configured) return configured;
  const models = await listModels(cfg);
  if (!models.length) throw new Error('模型列表为空，请先在 AI 助手设置中选择模型');
  return models[0].id;
}

/** 获取模型广场中已发布的模型列表。 */
async function listModels(cfg) {
  if (!cfg || !cfg.apiKey) throw new Error('请先填写 API Key');
  const base = String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
  const parsed = (() => {
    try { return new URL(base); } catch (e) { throw new Error('AI 接口地址不是合法 URL'); }
  })();
  // 公司网关同时提供两个别名；部分内网节点只开放 /v1/models，404 时自动回退。
  const urls = [...new Set([
    `${parsed.origin}/api/v1/models`,
    `${parsed.origin}/v1/models`,
  ])];
  let data;
  let lastError;
  for (const url of urls) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    const txt = await res.text();
    if (res.ok) {
      try { data = JSON.parse(txt); break; } catch (e) { throw new Error('模型列表接口返回的不是合法 JSON'); }
    }
    lastError = new Error(`模型列表接口返回 ${res.status}：${txt.slice(0, 400) || res.statusText}`);
    if (res.status !== 404) throw lastError;
  }
  if (!data) throw lastError || new Error('模型列表接口不可用');
  const models = Array.isArray(data && data.data) ? data.data : [];
  return models
    .filter((item) => item && item.id)
    .map((item) => ({
      id: String(item.id),
      contextLength: item.context_length ?? item.contextLength ?? null,
      inputPrice: item.input_price ?? item.inputPrice ?? null,
      outputPrice: item.output_price ?? item.outputPrice ?? null,
    }));
}

module.exports = { chat, test, listModels, buildUrl, buildModelsUrl, parseSSELine };
