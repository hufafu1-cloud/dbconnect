// Elasticsearch / OpenSearch 适配器（HTTP 接口，零新依赖）
//
// 定位是**查数据，不是管 ES**：索引管理、mapping 编辑、分片副本调整、集群运维
// 一概不做——那是 Kibana / OpenSearch Dashboards 的活，做不深还容易出事。
//
// 映射：
//   连接      → 集群
//   数据库    → 退化为单个伪库（用集群名），ES 没有库层级
//   「表」    → 索引
//   「视图」  → 别名（alias 本来就是"指向若干索引的命名指针"，与视图神似）
//   「行」    → 文档，列由 mapping 展平而来，另加 _id
//   查询编辑器 → ES SQL（POST /_sql；OpenSearch 是 /_plugins/_sql）
//
// 为什么不引 @elastic/elasticsearch：该客户端与服务端大版本强耦合
// （8.x 客户端默认拒连 7.x 服务端），会变成长期维护负担。
// Node 内置 http/https 足够，且自签证书的信任开关（rejectUnauthorized）
// 用内置模块控制最确定——全局 fetch 要配 undici dispatcher，在 Electron 里不够稳。
//
// 三处刻意的限制：
//   1. 网格只读。ES 文档有 _id，单文档改删技术上可行，但 ES **无事务**，
//      与本工具"编辑在事务中提交、失败整体回滚"的承诺冲突。
//   2. 不提供表设计器。mapping 已有字段的类型不可变，只能加字段。
//   3. 浏览受 index.max_result_window（默认 10000）限制，超出**明确拒绝**
//      并提示加筛选，而不是静默截断。导出走 scroll，不受该限制。
const http = require('http');
const https = require('https');
const { BaseAdapter } = require('./base');

/** 单次请求超时 */
const REQUEST_TIMEOUT = 30000;
/** 导出时每批取多少文档 */
const SCROLL_SIZE = 1000;
/** scroll 上下文保活时长 */
const SCROLL_KEEPALIVE = '2m';

class ElasticsearchAdapter extends BaseAdapter {
  get dialect() { return 'elasticsearch'; }

  get readonlyReason() {
    return 'Elasticsearch 在本工具中为只读浏览：网格不支持编辑。'
      + 'ES 没有事务，无法保证"失败整体回滚"，因此不开放文档编辑。'
      + '写入请用 _bulk 或专门的工具。';
  }

  get designerReason() {
    return 'Elasticsearch 的 mapping 中已有字段的类型不可修改（只能新增字段），'
      + '通用表设计器无法表达这一约束，因此不提供。索引结构请在「查看定义」中查看 mapping。';
  }

  get transactionSupport() {
    return { supported: false, warning: 'Elasticsearch 不支持事务，仅支持自动提交' };
  }

  get objectCaps() {
    return { routines: false, triggers: false, events: false, sequences: false, users: false, processes: false };
  }

  // ES 没有 SQL 标识符引用规则；这些只为满足基类契约
  quoteIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }

  literal(v) { return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`; }

  qualify(_db, _schema, table) { return String(table); }

  // ---------- HTTP ----------

  _baseOptions(path) {
    const c = this.cfg;
    const useHttps = !!(c.options || {}).https;
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (c.user) {
      const token = Buffer.from(`${c.user}:${c.password || ''}`).toString('base64');
      headers.authorization = `Basic ${token}`;
    }
    return {
      protocol: useHttps ? 'https:' : 'http:',
      hostname: c.host || 'localhost',
      port: Number(c.port) || 9200,
      path,
      headers,
      timeout: REQUEST_TIMEOUT,
      // 自签证书场景（自建集群很常见）：由用户在连接对话框显式选择是否信任
      rejectUnauthorized: !(c.options || {}).trustCert,
    };
  }

  _request(method, path, body) {
    const opts = { ...this._baseOptions(path), method };
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null) opts.headers['content-length'] = Buffer.byteLength(payload);
    const mod = opts.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(opts, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = null; }
          if (res.statusCode >= 200 && res.statusCode < 300) { resolve(parsed); return; }
          reject(new Error(this._errorText(res.statusCode, parsed, text)));
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`请求超时（${REQUEST_TIMEOUT / 1000} 秒）：${path}`)); });
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  /** 把 ES 的错误结构翻译成一句人能看懂的话，而不是丢一整坨 JSON */
  _errorText(status, parsed, raw) {
    const err = parsed && parsed.error;
    if (err && typeof err === 'object') {
      const root = Array.isArray(err.root_cause) && err.root_cause[0];
      const reason = err.reason || (root && root.reason) || '';
      const type = err.type || (root && root.type) || '';
      if (status === 401 || status === 403) {
        return `Elasticsearch 拒绝访问（HTTP ${status}）：${reason || type}。请检查用户名/密码或 API 权限。`;
      }
      return `Elasticsearch 错误（HTTP ${status}${type ? ' ' + type : ''}）：${reason || raw.slice(0, 200)}`;
    }
    if (status === 401 || status === 403) {
      return `Elasticsearch 拒绝访问（HTTP ${status}）。请检查用户名/密码或 API 权限。`;
    }
    return `Elasticsearch 错误（HTTP ${status}）：${String(raw || '').slice(0, 200)}`;
  }

  // ---------- 连接 ----------

  async connect() {
    const root = await this._request('GET', '/');
    const version = (root && root.version) || {};
    // OpenSearch 在 version.distribution 里自报家门；ES 没有这个字段
    this.isOpenSearch = String(version.distribution || '').toLowerCase() === 'opensearch';
    this.clusterName = root && root.cluster_name ? String(root.cluster_name) : 'cluster';
    this.serverVersion = this.isOpenSearch
      ? `OpenSearch ${version.number || ''}`.trim()
      : `Elasticsearch ${version.number || ''}`.trim();
    // SQL 接口的路径不同，响应结构也不一样（见 _runSql）。
    //
    // ⚠ format 参数在两边的含义**正好相反**，这点是真机验证撞出来的：
    //   ES:         ?format=json 返回 {columns, rows} —— 正是我们要的
    //   OpenSearch: ?format=json 表示"返回 ES 引擎的原生 DSL 响应"（hits 结构），
    //               要拿 {schema, datarows} 必须用 ?format=jdbc（也是它的默认值）
    // 用错的后果很隐蔽：HTTP 200、有响应体，但解析出来是空列空行，不报任何错。
    this.sqlPath = this.isOpenSearch ? '/_plugins/_sql?format=jdbc' : '/_sql?format=json';
    this.maxResultWindow = 10000;
  }

  async close() { /* 无长连接可关 */ }

  /** ES 没有库层级，退化为单个伪库；用集群名而不是硬编码，至少能看出连的是哪个集群 */
  async listDatabases() {
    return [this.clusterName || 'cluster'];
  }

  // ---------- 对象 ----------

  async listObjects() {
    const indices = await this._request(
      'GET', '/_cat/indices?format=json&h=index,docs.count,store.size,health&expand_wildcards=open',
    );
    const tables = (indices || [])
      // 隐藏以点开头的系统索引（.kibana / .security 等），它们不是用户数据
      .filter((row) => row && row.index && !String(row.index).startsWith('.'))
      .map((row) => ({
        name: row.index,
        rows: row['docs.count'] === undefined || row['docs.count'] === null
          ? null : Number(row['docs.count']),
        comment: `健康度 ${row.health || '未知'} · 占用 ${row['store.size'] || '未知'}`,
        engine: 'index',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // 别名 ≈ 视图：一个指向若干索引的命名指针
    let views = [];
    try {
      const aliases = await this._request('GET', '/_cat/aliases?format=json&h=alias,index');
      const byAlias = new Map();
      for (const row of aliases || []) {
        if (!row || !row.alias || String(row.alias).startsWith('.')) continue;
        const list = byAlias.get(row.alias) || [];
        list.push(row.index);
        byAlias.set(row.alias, list);
      }
      views = [...byAlias.keys()].sort().map((name) => ({ name }));
    } catch (e) {
      // 没有别名或无权限时不影响索引清单
    }
    return { tables, views };
  }

  /** 把嵌套 mapping 展平成 a.b.c 形式的列 */
  _flattenMapping(properties, prefix = '', out = []) {
    for (const [name, def] of Object.entries(properties || {})) {
      const full = prefix ? `${prefix}.${name}` : name;
      if (def && def.properties) {
        this._flattenMapping(def.properties, full, out);
      } else {
        out.push({ name: full, type: (def && def.type) || 'unknown', comment: '', key: '' });
      }
    }
    return out;
  }

  async tableInfo(_db, _schema, table) {
    const res = await this._request('GET', `/${encodeURIComponent(table)}/_mapping`);
    // 别名会返回它指向的多个索引；合并字段，重名以先出现的为准
    const seen = new Map();
    for (const entry of Object.values(res || {})) {
      const props = entry && entry.mappings && entry.mappings.properties;
      for (const col of this._flattenMapping(props)) {
        if (!seen.has(col.name)) seen.set(col.name, col);
      }
    }
    const columns = [
      { name: '_id', type: 'keyword', comment: '文档 ID', key: '' },
      ...[...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ];
    return {
      columns,
      indexes: [],
      pk: [],
      ddl: JSON.stringify(res, null, 2),
      readonlyReason: this.readonlyReason,
    };
  }

  // ---------- 数据 ----------

  /** 按展平后的路径从 _source 里取值；取到对象/数组就转成 JSON 文本 */
  _pick(source, path) {
    let cur = source;
    for (const part of String(path).split('.')) {
      if (cur === null || cur === undefined) return null;
      cur = cur[part];
    }
    if (cur === null || cur === undefined) return null;
    if (typeof cur === 'object') {
      try { return JSON.stringify(cur); } catch (e) { return String(cur); }
    }
    return cur;
  }

  async tableData(db, args) {
    const { table, page = 1, pageSize = 500 } = args;
    const safePage = Number(page);
    const safePageSize = Number(pageSize);
    if (!Number.isSafeInteger(safePage) || safePage < 1) throw new Error('页码必须是正整数');
    if (!Number.isSafeInteger(safePageSize) || safePageSize < 1 || safePageSize > 10000) {
      throw new Error('每页行数必须是 1 到 10000 之间的整数');
    }
    const from = (safePage - 1) * safePageSize;
    // ES 的 from+size 深翻页受 index.max_result_window 限制；超出会直接报错。
    // 与其让用户看到一句 ES 的原始报错，不如提前拦下并说清怎么办。
    if (from + safePageSize > this.maxResultWindow) {
      throw new Error(
        `Elasticsearch 的 from+size 翻页上限为 ${this.maxResultWindow}（index.max_result_window），`
        + `当前请求到第 ${from + safePageSize} 条已超出。请用筛选缩小范围，`
        + '或改用查询编辑器的 SQL；整表导出不受此限制。',
      );
    }
    const t0 = Date.now();
    const info = await this.tableInfo(db, null, table);
    const res = await this._request('POST', `/${encodeURIComponent(table)}/_search`, {
      from,
      size: safePageSize,
      // 按 _doc 排序最省资源，且翻页顺序稳定
      sort: [{ _doc: 'asc' }],
      track_total_hits: true,
    });
    const hits = (res && res.hits && res.hits.hits) || [];
    const columns = info.columns;
    const rows = hits.map((hit) => columns.map((col) => (
      col.name === '_id' ? hit._id : this._pick(hit._source, col.name)
    )));
    const totalRaw = res && res.hits && res.hits.total;
    const total = totalRaw && typeof totalRaw === 'object' ? totalRaw.value : totalRaw;
    return {
      columns: columns.map((c) => ({ name: c.name, type: c.type, comment: c.comment })),
      rows,
      total: total === undefined ? null : Number(total),
      pk: [],
      rowIdColumn: null,
      rowIds: null,
      readonlyReason: this.readonlyReason,
      ms: Date.now() - t0,
      page: safePage,
      pageSize: safePageSize,
    };
  }

  /**
   * 导出用的续传读取（契约见 exporter.exportTableByPages）。
   *
   * 用 scroll 而不是 from/size：后者受 max_result_window 限制，一万条以后就取不到了，
   * 而导出必须能把整个索引取完。scroll 在 ES 与 OpenSearch 上都可用。
   */
  async fetchTablePage({ db, table, limit, next }) {
    const info = await this.tableInfo(db, null, table);
    const columns = info.columns;
    const toRows = (hits) => hits.map((hit) => columns.map((col) => (
      col.name === '_id' ? hit._id : this._pick(hit._source, col.name)
    )));

    let res;
    if (next && next.scrollId) {
      res = await this._request('POST', '/_search/scroll', {
        scroll: SCROLL_KEEPALIVE, scroll_id: next.scrollId,
      });
    } else {
      res = await this._request(
        'POST',
        `/${encodeURIComponent(table)}/_search?scroll=${encodeURIComponent(SCROLL_KEEPALIVE)}`,
        { size: Math.min(limit || SCROLL_SIZE, SCROLL_SIZE), sort: [{ _doc: 'asc' }] },
      );
    }
    const hits = (res && res.hits && res.hits.hits) || [];
    const scrollId = res && res._scroll_id;
    if (!hits.length) {
      // 取完了：主动释放 scroll 上下文，不留给服务端自己超时
      if (scrollId) {
        await this._request('DELETE', '/_search/scroll', { scroll_id: [scrollId] }).catch(() => {});
      }
      return { columns: columns.map((c) => ({ name: c.name })), rows: [], next: null };
    }
    return {
      columns: columns.map((c) => ({ name: c.name })),
      rows: toRows(hits),
      next: scrollId ? { scrollId } : null,
    };
  }

  // ---------- 查询（ES SQL） ----------

  /**
   * ES 与 OpenSearch 的 SQL 响应结构不同：
   *   ES:         { columns: [{name,type}], rows: [[…]] }
   *   OpenSearch: { schema:  [{name,type}], datarows: [[…]] }
   */
  async _runSql(sql) {
    const res = await this._request('POST', this.sqlPath, { query: sql });
    const cols = res && (res.columns || res.schema);
    const rows = res && (res.rows || res.datarows);
    // 两种结构都对不上时**明确报错**，不要静默返回空结果集。
    // 这正是 OpenSearch 端点写错时的表现：HTTP 200、有响应体，但既没有
    // columns/rows 也没有 schema/datarows，界面只会显示"0 行"，
    // 用户完全看不出是查询没匹配还是工具解析错了。
    if (!Array.isArray(cols) || !Array.isArray(rows)) {
      const shape = res && typeof res === 'object' ? Object.keys(res).join(', ') : typeof res;
      throw new Error(
        `无法解析 ${this.isOpenSearch ? 'OpenSearch' : 'Elasticsearch'} 的 SQL 响应结构`
        + `（顶层字段：${shape}）。请确认服务端已启用 SQL 插件，并反馈该服务端版本。`,
      );
    }
    return {
      columns: cols.map((c) => ({ name: c.name || c.alias || '', type: c.type || '' })),
      rows: rows.map((row) => row.map((v) => (
        v !== null && typeof v === 'object' ? JSON.stringify(v) : v
      ))),
    };
  }

  async exec(_db, sql) {
    return this._runSql(String(sql).trim());
  }

  async runScript(_db, text, opts = {}) {
    // ES SQL 一次只接受一条语句；按分号拆开逐条执行，与 SQL 类型的体验保持一致
    const statements = String(text)
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('--'));
    const out = [];
    for (const sql of statements) {
      const t0 = Date.now();
      try {
        const r = await this._runSql(sql);
        const maxRows = opts.maxRows;
        const rows = maxRows && r.rows.length > maxRows ? r.rows.slice(0, maxRows) : r.rows;
        out.push({
          sql,
          ms: Date.now() - t0,
          columns: r.columns,
          rows,
          rowCount: rows.length,
          rowCountExact: true,
          truncated: !!(maxRows && r.rows.length > maxRows),
        });
      } catch (err) {
        out.push({ sql, ms: Date.now() - t0, error: (err && err.message) || String(err) });
      }
    }
    return out;
  }

  async objectDdl(_db, _schema, _kind, name) {
    const res = await this._request('GET', `/${encodeURIComponent(name)}/_mapping`);
    return JSON.stringify(res, null, 2);
  }

  async action(_db, a) {
    throw new Error(`Elasticsearch 连接为只读，不支持「${a && a.action}」操作。`
      + '索引管理请使用 Kibana / OpenSearch Dashboards。');
  }

  async explainPlan() {
    throw new Error('Elasticsearch 暂不支持执行计划可视化');
  }
}

module.exports = { ElasticsearchAdapter };
