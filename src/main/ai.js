// AI 客户端：对接 OpenAI 兼容的大模型接口（DeepSeek / OpenAI / Moonshot / 通义 / 智谱 / Ollama 等）
// 仅用全局 fetch（Electron 主进程自带 undici）。

/** 由 baseUrl 推导 chat/completions 地址 */
function buildUrl(baseUrl) {
  let b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) throw new Error('未配置 AI 接口地址');
  if (/\/chat\/completions$/i.test(b)) return b;
  return b + '/chat/completions';
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
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({
      model: cfg.model || 'deepseek-chat',
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
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({
      model: cfg.model || 'deepseek-chat',
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
  return { model: j.model || cfg.model, reply: String(reply).slice(0, 60) };
}

module.exports = { chat, test, buildUrl, parseSSELine };
