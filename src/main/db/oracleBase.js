// Oracle 方言基类：SQL 方言 + 数据字典查询，不含任何驱动细节。
//
// 由两个适配器共用：
//   - oracle.js    原生 Oracle，走 oracledb 的 Thin 模式（纯 JS，无需 Instant Client）
//   - oboracle.js  OceanBase 的 Oracle 模式租户，走 mysql2 线协议
//
// 两者的 SQL 方言与数据字典完全一致（标识符双引号、字符串无反斜杠转义、ROWNUM 分页、
// 「数据库」层级即 Schema、元数据取自 all_* 视图、DBMS_METADATA 取 DDL），
// 差别只在连接与执行方式，因此把方言收在这里，传输交给子类实现。
// 好处是数据字典查询的兼容性修复一次两边都受益。
//
// 子类必须实现：connect / close / withSession / cancel / _run / _q，
// 契约见文件末尾的抽象方法说明。
const { BaseAdapter } = require('./base');
const { synthesizeDDL, limitQueryRows } = require('./sqlutil');

class OracleBaseAdapter extends BaseAdapter {
  get dialect() { return 'oracle'; }

  // quoteIdent/literal 沿用基类：双引号标识符、'' 转义、无反斜杠转义

  qualify(db, _schema, table) {
    return (db ? this.quoteIdent(db) + '.' : '') + this.quoteIdent(table);
  }

  /** ROWNUM 子查询分页（兼容 OB Oracle 的 11g 风格语法） */
  pageSql(select, orderClause, limit, offset) {
    const inner = `${select}${orderClause}`;
    return `SELECT * FROM (SELECT t__.*, ROWNUM AS "RN__" FROM (${inner}) t__ WHERE ROWNUM <= ${offset + limit}) WHERE "RN__" > ${offset}`;
  }

  _prepareScriptQuery(sql, opts) {
    if (!opts || opts.maxRows === undefined || !this.supportsFetchFirst) return { sql, applied: false };
    return limitQueryRows(sql, 'oracle12', opts.maxRows);
  }

  get objectCaps() {
    return { routines: true, triggers: true, events: false, sequences: true, users: false, processes: false };
  }

  blobLiteral(buf) { return `HEXTORAW('${buf.toString('hex')}')`; }

  async listRoutines(db) {
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    const rows = await this._q(
      `SELECT object_name, object_type FROM all_objects
       WHERE owner = ${this.literal(db)} AND object_type IN ('PROCEDURE', 'FUNCTION')
       ORDER BY object_name`);
    return rows.map((r) => ({ name: val(r, 'object_name'), type: val(r, 'object_type'), comment: '' }));
  }

  async listTriggers(db) {
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    const rows = await this._q(
      `SELECT trigger_name, table_name FROM all_triggers
       WHERE owner = ${this.literal(db)} ORDER BY trigger_name`);
    return rows.map((r) => ({ name: val(r, 'trigger_name'), table: val(r, 'table_name') }));
  }

  async listSequences(db) {
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    const rows = await this._q(
      `SELECT sequence_name FROM all_sequences
       WHERE sequence_owner = ${this.literal(db)} ORDER BY sequence_name`);
    return rows.map((r) => ({ name: val(r, 'sequence_name') }));
  }

  async objectDdl(db, _schema, kind, name) {
    const L = (v) => this.literal(v);
    const kindMap = { PROCEDURE: 'PROCEDURE', FUNCTION: 'FUNCTION', TRIGGER: 'TRIGGER', SEQUENCE: 'SEQUENCE' };
    const mk = kindMap[kind];
    if (!mk) throw new Error('不支持的对象类型: ' + kind);
    try {
      const rows = await this._q(
        `SELECT dbms_metadata.get_ddl(${L(mk)}, ${L(name)}, ${L(db)}) AS "DDL" FROM dual`);
      const ddl = String(rows[0].DDL || '').trim();
      if (ddl) return ddl;
    } catch (e) { /* fallthrough */ }
    // 退化：从 all_source 拼接（过程/函数/触发器）
    const src = await this._q(
      `SELECT text FROM all_source WHERE owner = ${L(db)} AND name = ${L(name)} ORDER BY line`);
    if (src.length) {
      const val = (r) => (r.TEXT !== undefined ? r.TEXT : r.text);
      return 'CREATE OR REPLACE ' + src.map(val).join('');
    }
    throw new Error('无法获取定义');
  }

  async viewDdl(db, _schema, view) {
    const rows = await this._q(
      `SELECT dbms_metadata.get_ddl('VIEW', ${this.literal(view)}, ${this.literal(db)}) AS "DDL" FROM dual`);
    const ddl = rows[0] && (rows[0].DDL !== undefined ? rows[0].DDL : rows[0].ddl);
    if (!ddl) throw new Error('无法获取视图定义');
    return String(ddl).trim();
  }

  async listAllColumns(db) {
    const rows = await this._q(
      `SELECT table_name, column_name FROM all_tab_columns
       WHERE owner = ${this.literal(db)} ORDER BY table_name, column_id`);
    const map = {};
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    for (const r of rows) {
      const t = val(r, 'table_name');
      (map[t] = map[t] || []).push(val(r, 'column_name'));
    }
    return map;
  }

  async explainPlan(db, sql) {
    return this.withSession(db, async (run) => {
      await run('EXPLAIN PLAN FOR ' + sql);
      const r = await run('SELECT plan_table_output FROM TABLE(dbms_xplan.display(NULL, NULL, ' + this.literal('TYPICAL') + '))');
      const text = (r.rows || []).map((row) => row[0]).join('\n');
      return { format: 'text', text: text || '(空计划)' };
    });
  }

  async listForeignKeys(db, _schema, table) {
    const L = (v) => this.literal(v);
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    const rebuildSafe = (r) => /^ENABLED?$/.test(String(val(r, 'status') || 'ENABLED').toUpperCase())
      && String(val(r, 'deferrable') || 'NOT DEFERRABLE').toUpperCase() === 'NOT DEFERRABLE'
      && String(val(r, 'deferred') || 'IMMEDIATE').toUpperCase() === 'IMMEDIATE'
      && String(val(r, 'validated') || 'VALIDATED').toUpperCase() === 'VALIDATED'
      && String(val(r, 'rely') || 'NORELY').toUpperCase() === 'NORELY';
    const rows = await this._q(
      `SELECT ac.constraint_name AS name, cc.column_name AS col, cc.position AS pos,
              rc.owner AS refowner, rc.table_name AS reftab, rcc.column_name AS refcol,
              ac.delete_rule AS delete_rule, ac.status, ac.deferrable, ac.deferred, ac.validated, ac.rely
       FROM all_constraints ac
       JOIN all_cons_columns cc ON cc.owner = ac.owner AND cc.constraint_name = ac.constraint_name
       JOIN all_constraints rc ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name
       JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
       WHERE ac.constraint_type = 'R' AND ac.owner = ${L(db)} AND ac.table_name = ${L(table)}
       ORDER BY ac.constraint_name, cc.position`);
    const map = new Map();
    for (const r of rows) {
      const name = val(r, 'name');
      if (!map.has(name)) map.set(name, {
        name, columns: [], refSchema: val(r, 'refowner') === db ? null : val(r, 'refowner'),
        refTable: val(r, 'reftab'), refColumns: [], onUpdate: 'NO ACTION',
        onDelete: val(r, 'delete_rule') || 'NO ACTION',
        rebuildSafe: rebuildSafe(r),
      });
      const fk = map.get(name);
      fk.columns.push(val(r, 'col'));
      fk.refColumns.push(val(r, 'refcol'));
    }
    return [...map.values()];
  }

  async listReferencingForeignKeys(db, _schema, table) {
    const L = (v) => this.literal(v);
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    const rows = await this._q(
      `SELECT ac.constraint_name AS name, ac.owner AS child_schema,
              ac.table_name AS child_table, cc.column_name AS col,
              rcc.column_name AS refcol, cc.position AS pos
       FROM all_constraints ac
       JOIN all_cons_columns cc ON cc.owner = ac.owner AND cc.constraint_name = ac.constraint_name
       JOIN all_constraints rc ON rc.owner = ac.r_owner AND rc.constraint_name = ac.r_constraint_name
       JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name AND rcc.position = cc.position
       WHERE ac.constraint_type = 'R' AND rc.owner = ${L(db)} AND rc.table_name = ${L(table)}
         AND NOT (ac.owner = ${L(db)} AND ac.table_name = ${L(table)})
       ORDER BY ac.owner, ac.table_name, ac.constraint_name, cc.position`);
    const map = new Map();
    for (const row of rows) {
      const name = val(row, 'name');
      const childSchema = val(row, 'child_schema');
      const childTable = val(row, 'child_table');
      const key = `${childSchema}\0${childTable}\0${name}`;
      if (!map.has(key)) map.set(key, {
        name, schema: childSchema, table: childTable, columns: [], refColumns: [],
      });
      const fk = map.get(key);
      fk.columns.push(val(row, 'col'));
      fk.refColumns.push(val(row, 'refcol'));
    }
    return [...map.values()];
  }

  async listConstraints(db, _schema, table) {
    const L = (v) => this.literal(v);
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    const rebuildSafe = (r) => /^ENABLED?$/.test(String(val(r, 'status') || 'ENABLED').toUpperCase())
      && String(val(r, 'deferrable') || 'NOT DEFERRABLE').toUpperCase() === 'NOT DEFERRABLE'
      && String(val(r, 'deferred') || 'IMMEDIATE').toUpperCase() === 'IMMEDIATE'
      && String(val(r, 'validated') || 'VALIDATED').toUpperCase() === 'VALIDATED'
      && String(val(r, 'rely') || 'NORELY').toUpperCase() === 'NORELY';
    const nonNullRows = await this._q(
      `SELECT column_name
       FROM all_tab_columns
       WHERE owner = ${L(db)} AND table_name = ${L(table)} AND nullable = 'N'`);
    const nonNullColumns = new Set(nonNullRows.map((row) => val(row, 'column_name')));

    const uniqueRows = await this._q(
      `SELECT ac.constraint_name AS name, ac.index_name AS index_name,
              ac.status, ac.deferrable, ac.deferred, ac.validated, ac.rely,
              cc.column_name AS col, cc.position AS pos
       FROM all_constraints ac
       JOIN all_cons_columns cc ON cc.owner = ac.owner AND cc.constraint_name = ac.constraint_name
       WHERE ac.constraint_type = 'U' AND ac.owner = ${L(db)} AND ac.table_name = ${L(table)}
       ORDER BY ac.constraint_name, cc.position`);
    const uniqueMap = new Map();
    for (const row of uniqueRows) {
      const name = val(row, 'name');
      if (!uniqueMap.has(name)) uniqueMap.set(name, {
        kind: 'unique', name, columns: [], expression: '', indexName: val(row, 'index_name') || null,
        // Oracle UNIQUE may carry index storage/physical attributes that this grid cannot express.
        rebuildSafe: false,
      });
      uniqueMap.get(name).columns.push(val(row, 'col'));
    }

    let checkRows;
    let usedSearchConditionVc = true;
    try {
      checkRows = await this._q(
        `SELECT constraint_name AS name, search_condition_vc AS expression,
                status, deferrable, deferred, validated, rely
         FROM all_constraints
         WHERE constraint_type = 'C' AND owner = ${L(db)} AND table_name = ${L(table)}
         ORDER BY constraint_name`);
    } catch (searchConditionVcError) {
      usedSearchConditionVc = false;
      try {
        checkRows = await this._q(
          `SELECT constraint_name AS name, search_condition AS expression,
                  status, deferrable, deferred, validated, rely
           FROM all_constraints
           WHERE constraint_type = 'C' AND owner = ${L(db)} AND table_name = ${L(table)}
           ORDER BY constraint_name`);
      } catch (searchConditionError) {
        throw new Error(`读取 CHECK 约束表达式失败，已禁止在设计器中修改该表：SEARCH_CONDITION_VC: ${searchConditionVcError.message || searchConditionVcError}; SEARCH_CONDITION: ${searchConditionError.message || searchConditionError}`);
      }
    }

    const checkColumnRows = await this._q(
      `SELECT ac.constraint_name AS name, cc.column_name AS col, cc.position AS pos
       FROM all_constraints ac
       LEFT JOIN all_cons_columns cc ON cc.owner = ac.owner AND cc.constraint_name = ac.constraint_name
       WHERE ac.constraint_type = 'C' AND ac.owner = ${L(db)} AND ac.table_name = ${L(table)}
       ORDER BY ac.constraint_name, cc.position`);
    const checkColumns = new Map();
    for (const row of checkColumnRows) {
      const name = val(row, 'name');
      if (!checkColumns.has(name)) checkColumns.set(name, []);
      const column = val(row, 'col');
      if (column !== null && column !== undefined && !checkColumns.get(name).includes(column)) {
        checkColumns.get(name).push(column);
      }
    }

    const checkMap = new Map();
    for (const row of checkRows) {
      const name = val(row, 'name');
      const rawExpression = val(row, 'expression');
      if (rawExpression === null || rawExpression === undefined
          || (typeof rawExpression === 'object' && !Buffer.isBuffer(rawExpression))) {
        throw new Error(`CHECK 约束 ${name || '(unknown)'} 的表达式元数据不完整，已禁止在设计器中修改该表`);
      }
      const expression = (Buffer.isBuffer(rawExpression)
        ? rawExpression.toString('utf8') : String(rawExpression)).trim();
      if (!expression || (usedSearchConditionVc && expression.length >= 4000)) {
        throw new Error(`CHECK 约束 ${name || '(unknown)'} 的表达式缺失或疑似被截断，已禁止在设计器中修改该表`);
      }
      if (checkMap.has(name)) {
        throw new Error(`CHECK 约束 ${name || '(unknown)'} 的表达式元数据重复，已禁止在设计器中修改该表`);
      }
      checkMap.set(name, {
        name, expression, columns: checkColumns.get(name) || [], row,
      });
    }
    for (const name of checkColumns.keys()) {
      if (!checkMap.has(name)) {
        throw new Error(`CHECK 约束 ${name || '(unknown)'} 的表达式元数据缺失，已禁止在设计器中修改该表`);
      }
    }

    const stripOuterParens = (value) => {
      let text = String(value).trim();
      while (text.startsWith('(') && text.endsWith(')')) {
        let depth = 0;
        let quote = null;
        let enclosesAll = true;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (quote) {
            if (ch === quote && text[i + 1] === quote) { i++; continue; }
            if (ch === quote) quote = null;
            continue;
          }
          if (ch === "'" || ch === '"') { quote = ch; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') {
            depth--;
            if (depth === 0 && i !== text.length - 1) { enclosesAll = false; break; }
            if (depth < 0) { enclosesAll = false; break; }
          }
        }
        if (!enclosesAll || depth !== 0 || quote) break;
        text = text.slice(1, -1).trim();
      }
      return text;
    };
    const isNotNullExpression = (expression, column) => {
      const match = /^(?:"((?:[^"]|"")*)"|([A-Za-z_$#][A-Za-z0-9_$#]*))\s+IS\s+NOT\s+NULL$/i.exec(
        stripOuterParens(expression),
      );
      if (!match) return false;
      const actual = String(column);
      if (match[1] !== undefined) return match[1].replace(/""/g, '"') === actual;
      return match[2].toUpperCase() === actual.toUpperCase();
    };

    const out = [...uniqueMap.values()];
    for (const item of checkMap.values()) {
      const onlyColumn = item.columns.length === 1 ? item.columns[0] : null;
      // Oracle 把 NOT NULL 也表示为系统 CHECK；仅在列元数据和表达式均精确匹配时排除。
      if (onlyColumn && nonNullColumns.has(onlyColumn)
          && isNotNullExpression(item.expression, onlyColumn)) continue;
      out.push({
        kind: 'check', name: item.name, columns: [], expression: item.expression,
        rebuildSafe: rebuildSafe(item.row),
      });
    }
    return out;
  }

  /** Oracle 模式的“数据库”层 = Schema（用户） */
  async listDatabases() {
    const rows = await this._q('SELECT username FROM all_users ORDER BY username');
    return rows.map((r) => r.USERNAME !== undefined ? r.USERNAME : r.username);
  }

  async listObjects(db) {
    const L = (v) => this.literal(v);
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    // 逐级降级：联查注释 → 表名+行数 → 仅表名（保证任何 OB Oracle 版本都至少能列出表）
    let tRows;
    try {
      tRows = await this._q(
        `SELECT t.table_name, t.num_rows, t.blocks, c.comments FROM all_tables t
         LEFT JOIN all_tab_comments c ON c.owner = t.owner AND c.table_name = t.table_name
         WHERE t.owner = ${L(db)} ORDER BY t.table_name`);
    } catch (e1) {
      try {
        tRows = await this._q(
          `SELECT table_name, num_rows, blocks FROM all_tables WHERE owner = ${L(db)} ORDER BY table_name`);
      } catch (e2) {
        try {
          tRows = await this._q(
            `SELECT table_name, num_rows FROM all_tables WHERE owner = ${L(db)} ORDER BY table_name`);
        } catch (e3) {
          tRows = await this._q(
            `SELECT table_name FROM all_tables WHERE owner = ${L(db)} ORDER BY table_name`);
        }
      }
    }
    let vRows = [];
    try {
      vRows = await this._q(
        `SELECT view_name FROM all_views WHERE owner = ${L(db)} ORDER BY view_name`);
    } catch (e) { /* 视图目录不可用时只列表 */ }
    return {
      tables: tRows.map((r) => {
        const nr = val(r, 'num_rows');
        const blocks = val(r, 'blocks');
        let rows = null;
        if (nr !== null && nr !== undefined) {
          const n = Number(nr);
          if (n > 0) rows = n;
          else if (n === 0 && blocks !== null && blocks !== undefined && Number(blocks) > 0) rows = null;
          else rows = n;
        }
        return {
          name: val(r, 'table_name'),
          rows,
          comment: val(r, 'comments') || '',
          engine: '',
        };
      }),
      views: vRows.map((r) => ({ name: val(r, 'view_name') })),
    };
  }

  /** 无主键表用 ROWID 定位行（Navicat 同款做法） */
  async rowIdFor(_db, _schema, _table) {
    return 'ROWID';
  }

  async tableInfo(db, _schema, table) {
    const L = (v) => this.literal(v);
    const val = (r, k) => (r[k.toUpperCase()] !== undefined ? r[k.toUpperCase()] : r[k.toLowerCase()]);
    const cols = await this._q(
      `SELECT c.column_name, c.data_type, c.data_length, c.data_precision, c.data_scale,
              c.nullable, c.data_default, cm.comments
       FROM all_tab_columns c
       LEFT JOIN all_col_comments cm ON cm.owner = c.owner AND cm.table_name = c.table_name AND cm.column_name = c.column_name
       WHERE c.owner = ${L(db)} AND c.table_name = ${L(table)} ORDER BY c.column_id`);
    const pkRows = await this._q(
      `SELECT cc.column_name FROM all_constraints c
       JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
       WHERE c.owner = ${L(db)} AND c.table_name = ${L(table)} AND c.constraint_type = 'P'
       ORDER BY cc.position`);
    const pk = pkRows.map((r) => val(r, 'column_name'));
    const typeStr = (r) => {
      const t = String(val(r, 'data_type') || '');
      const prec = val(r, 'data_precision'), scale = val(r, 'data_scale'), len = val(r, 'data_length');
      if (t === 'NUMBER') {
        if (prec === null || prec === undefined) return 'NUMBER';
        return Number(scale) ? `NUMBER(${prec},${scale})` : `NUMBER(${prec})`;
      }
      if (['VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR', 'RAW'].includes(t)) return `${t}(${len})`;
      return t;
    };
    const columns = cols.map((r) => ({
      name: val(r, 'column_name'),
      type: typeStr(r),
      nullable: val(r, 'nullable') === 'Y',
      def: val(r, 'data_default') === null || val(r, 'data_default') === undefined ? null : String(val(r, 'data_default')).trim(),
      key: pk.includes(val(r, 'column_name')) ? 'PRI' : '',
      extra: '',
      comment: val(r, 'comments') || '',
      // OceanBase Oracle 兼容视图在不同版本对虚拟、隐藏、identity、
      // collation 等属性暴露不一致；既有栏位只读，避免 ALTER 时降级。
      editSafe: false,
      editUnsafeReason: 'OceanBase Oracle 既有栏位可能含虚拟、隐藏或标识等高级属性；请使用迁移 SQL 修改',
    }));
    let indexes = [];
    let metadataComplete = true;
    try {
      const ix = await this._q(
        `SELECT i.index_name, i.uniqueness, ic.column_name
         FROM all_indexes i JOIN all_ind_columns ic
           ON ic.index_owner = i.owner AND ic.index_name = i.index_name
         WHERE i.table_owner = ${L(db)} AND i.table_name = ${L(table)}
         ORDER BY i.index_name, ic.column_position`);
      const map = new Map();
      for (const r of ix) {
        const nm = val(r, 'index_name');
        if (!map.has(nm)) map.set(nm, { name: nm, columns: [], unique: val(r, 'uniqueness') === 'UNIQUE', primary: false });
        map.get(nm).columns.push(val(r, 'column_name'));
      }
      indexes = [...map.values()];
    } catch (e) { metadataComplete = false; }
    let ddl = '';
    try {
      const rows = await this._q(
        `SELECT dbms_metadata.get_ddl('TABLE', ${L(table)}, ${L(db)}) AS "DDL" FROM dual`);
      ddl = String(rows[0].DDL || '').trim();
    } catch (e) {
      ddl = synthesizeDDL(this.qualify(db, null, table), columns, pk, indexes, (n) => this.quoteIdent(n));
    }
    let tableComment = '';
    try {
      const r = await this._q(
        `SELECT comments FROM all_tab_comments WHERE owner = ${L(db)} AND table_name = ${L(table)}`);
      tableComment = (r[0] && (r[0].COMMENTS !== undefined ? r[0].COMMENTS : r[0].comments)) || '';
    } catch (e) { /* ignore */ }
    return { columns, indexes, pk, ddl, tableComment, metadataComplete };
  }

  /** 去掉 ROWNUM 分页引入的辅助列 RN__ */
  async tableData(db, args) {
    const r = await super.tableData(db, args);
    const i = r.columns.findIndex((c) => c.name === 'RN__');
    if (i >= 0) {
      r.columns.splice(i, 1);
      for (const row of r.rows) row.splice(i, 1);
    }
    return r;
  }

  /**
   * Oracle 没有 BEGIN 语句（BEGIN 是 PL/SQL 块的开头），事务靠"关闭自动提交"实现。
   * 但"怎么关"是驱动相关的：
   *   - OceanBase 走 MySQL 线协议，可以直接执行 SET AUTOCOMMIT = 0
   *   - 原生 Oracle 没有 SET AUTOCOMMIT（那是 SQL*Plus 的客户端命令，
   *     服务端会报 ORA-00900），必须由驱动的 autoCommit 选项控制
   * 因此这三个方法由子类给出各自的实现，本类不假定任何一种。
   * COMMIT / ROLLBACK 是标准 SQL，两边通用，放在这里。
   */
  _transactionBeginSqls() { return this._mustImplement('_transactionBeginSqls'); }

  _transactionEndSqls(action) {
    return [action === 'commit' ? 'COMMIT' : 'ROLLBACK'];
  }

  _transactionCleanupSqls() { return this._mustImplement('_transactionCleanupSqls'); }

  async execTxn(db, sqls) {
    await this.withSession(db, async (run) => {
      for (const sql of this._transactionBeginSqls()) await run(sql);
      let idx = 0;
      try {
        for (const s of sqls) { idx++; await run(s); }
        for (const sql of this._transactionEndSqls('commit')) await run(sql);
      } catch (err) {
        try {
          for (const sql of this._transactionEndSqls('rollback')) await run(sql);
        } catch (e) { /* ignore */ }
        throw new Error(`第 ${idx} 条语句失败: ${(err && err.message) || err}\nSQL: ${sqls[idx - 1]}`);
      } finally {
        for (const sql of this._transactionCleanupSqls()) {
          try { await run(sql); } catch (e) { /* ignore */ }
        }
      }
    });
  }

  renameSql(db, _schema, table, newName) {
    return `ALTER TABLE ${this.qualify(db, null, table)} RENAME TO ${this.quoteIdent(newName)}`;
  }

  async action(db, a) {
    if (a.action === 'createDatabase' || a.action === 'dropDatabase') {
      throw new Error('Oracle 模式没有数据库层级，请用 SQL 管理用户/Schema（CREATE USER / DROP USER）');
    }
    return super.action(db, a);
  }

  // ---------- 抽象方法：由具体驱动的子类实现 ----------
  //
  // connect()                建立连接池并设置 serverVersion、supportsFetchFirst
  // close()                  关闭连接池
  // withSession(db, fn, opts) 取一个连接、按需 ALTER SESSION SET CURRENT_SCHEMA，
  //                          再以 run(sql, opts) 回调交给 fn；须支持逐请求取消与会话作废
  // cancel(requestId)        终止该请求占用的会话
  // _run(conn, sql, opts)    执行单条语句，返回 {columns, rows, rowLimitApplied} /
  //                          {affected, message} / {multi:[...]}
  // _q(sql)                  内部元数据查询，返回行对象数组；
  //                          **列名大小写不做保证**，方言层一律用 val(r, key) 兼容读取
  _mustImplement(name) {
    throw new Error(`${this.constructor.name} 未实现 ${name}()`);
  }

  async connect() { this._mustImplement('connect'); }

  async close() { this._mustImplement('close'); }

  async withSession() { this._mustImplement('withSession'); }

  async cancel() { this._mustImplement('cancel'); }

  async _run() { this._mustImplement('_run'); }

  async _q() { this._mustImplement('_q'); }
}

module.exports = { OracleBaseAdapter };
