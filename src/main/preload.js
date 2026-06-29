// 预加载脚本：以最小面暴露 IPC API
const { contextBridge, ipcRenderer } = require('electron');

const inv = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).then((r) => {
    if (r && r.ok) return r.data;
    throw new Error((r && r.error) || '未知错误');
  });

contextBridge.exposeInMainWorld('api', {
  conn: {
    list: () => inv('conn:list'),
    save: (c) => inv('conn:save', c),
    remove: (id) => inv('conn:delete', id),
    test: (cfg) => inv('conn:test', cfg),
  },
  groups: {
    list: () => inv('groups:list'),
    add: (name) => inv('groups:add', { name }),
    rename: (oldName, newName) => inv('groups:rename', { oldName, newName }),
    remove: (name) => inv('groups:remove', { name }),
  },
  db: {
    open: (connId) => inv('db:open', connId),
    close: (connId) => inv('db:close', connId),
    databases: (connId) => inv('db:databases', connId),
    schemas: (connId, db) => inv('db:schemas', { connId, db }),
    objects: (connId, db, schema) => inv('db:objects', { connId, db, schema }),
    tableInfo: (connId, t) => inv('db:tableInfo', { connId, ...t }),
    tableData: (connId, t) => inv('db:tableData', { connId, ...t }),
    query: (connId, t) => inv('db:query', { connId, ...t }),
    applyEdits: (connId, t) => inv('db:applyEdits', { connId, ...t }),
    action: (connId, t) => inv('db:action', { connId, ...t }),
    exportTable: (connId, t) => inv('db:exportTable', { connId, ...t }),
    exportRows: (connId, t) => inv('db:exportRows', { connId, ...t }),
    cancel: (connId) => inv('db:cancel', { connId }),
    allColumns: (connId, db, schema) => inv('db:allColumns', { connId, db, schema }),
    foreignKeys: (connId, t) => inv('db:foreignKeys', { connId, ...t }),
    erModel: (connId, db, schema, opts) => inv('db:erModel', { connId, db, schema, opts }),
    explain: (connId, db, sql) => inv('db:explain', { connId, db, sql }),
    cellBlob: (connId, t) => inv('db:cellBlob', { connId, ...t }),
    search: (connId, t) => inv('db:search', { connId, ...t }),
    onSearchProgress: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('search:progress', listener);
      return () => ipcRenderer.removeListener('search:progress', listener);
    },
    objectCaps: (connId) => inv('db:objectCaps', { connId }),
    routines: (connId, db, schema) => inv('db:routines', { connId, db, schema }),
    triggers: (connId, db, schema) => inv('db:triggers', { connId, db, schema }),
    events: (connId, db) => inv('db:events', { connId, db }),
    sequences: (connId, db, schema) => inv('db:sequences', { connId, db, schema }),
    users: (connId) => inv('db:users', { connId }),
    objectDdl: (connId, t) => inv('db:objectDdl', { connId, ...t }),
    processes: (connId) => inv('db:processes', { connId }),
    killProcess: (connId, pid) => inv('db:killProcess', { connId, pid }),
  },
  dba: {
    transfer: (t) => inv('dba:transfer', t),
    dump: (connId, t) => inv('dba:dump', { connId, ...t }),
    runSqlFile: (connId, t) => inv('dba:runSqlFile', { connId, ...t }),
    structDiff: (t) => inv('dba:structDiff', t),
    execSqls: (connId, db, sqls) => inv('dba:execSqls', { connId, db, sqls }),
    dataSync: (t) => inv('dba:dataSync', t),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('dba:progress', listener);
      return () => ipcRenderer.removeListener('dba:progress', listener);
    },
  },
  queries: {
    list: (connId) => inv('queries:list', { connId }),
    save: (q) => inv('queries:save', q),
    rename: (id, name) => inv('queries:rename', { id, name }),
    remove: (id) => inv('queries:delete', { id }),
  },
  design: {
    meta: (connId) => inv('design:meta', { connId }),
    model: (connId, t) => inv('design:model', { connId, ...t }),
    ddl: (connId, t) => inv('design:ddl', { connId, ...t }),
    apply: (connId, t) => inv('design:apply', { connId, ...t }),
  },
  imp: {
    parse: (opts) => inv('import:parse', opts),
    run: (connId, t) => inv('import:run', { connId, ...t }),
    onProgress: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('import:progress', listener);
      return () => ipcRenderer.removeListener('import:progress', listener);
    },
  },
  dlg: {
    openFile: (opts) => inv('dlg:openFile', opts),
    saveFile: (opts) => inv('dlg:saveFile', opts),
  },
  file: {
    read: (p) => inv('file:read', p),
    write: (p, content) => inv('file:write', p, content),
    writeBase64: (p, b64) => inv('file:writeBase64', p, b64),
  },
  ai: {
    getConfig: () => inv('ai:getConfig'),
    saveConfig: (c) => inv('ai:saveConfig', c),
    test: (c) => inv('ai:test', c),
    chat: (reqId, messages) => inv('ai:chat', { reqId, messages }),
    cancel: (reqId) => inv('ai:cancel', { reqId }),
    onDelta: (cb) => {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('ai:delta', listener);
      return () => ipcRenderer.removeListener('ai:delta', listener);
    },
  },
  history: {
    list: (opts) => inv('history:list', opts),
    clear: () => inv('history:clear'),
  },
  sql: {
    format: (opts) => inv('sql:format', opts),
  },
  app: {
    info: () => inv('app:info'),
    confirmClose: () => ipcRenderer.send('app:confirm-close'),
    onCloseRequest: (cb) => ipcRenderer.on('app:close-request', () => cb()),
    onMenuAction: (cb) => ipcRenderer.on('menu:action', (_e, id) => cb(id)),
    openExternal: (url) => inv('app:openExternal', url),
    winCmd: (cmd) => inv('app:winCmd', cmd),
  },
});
