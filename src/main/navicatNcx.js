const sax = require('sax');
const { decryptNavicatSecret } = require('./navicatCrypto');

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_NODES = 20000;
const MAX_DEPTH = 64;
const MAX_CONNECTIONS = 1000;

const DEFAULT_PORTS = {
  mysql: 3306,
  postgres: 5432,
  mssql: 1433,
  clickhouse: 8123,
  oceanbase: 2881,
  oboracle: 2881,
};

function normalizedKey(value) {
  return String(value || '').split(':').pop().replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function cleanText(value, max = 512) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|y|on|enabled)$/i.test(String(value).trim());
}

function asPort(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 65535 ? number : fallback;
}

function decodeUtf16Be(buffer) {
  const evenLength = buffer.length - (buffer.length % 2);
  const swapped = Buffer.allocUnsafe(evenLength);
  for (let i = 0; i < evenLength; i += 2) {
    swapped[i] = buffer[i + 1];
    swapped[i + 1] = buffer[i];
  }
  return swapped.toString('utf16le');
}

function decodeNcxBuffer(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || '');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('NCX 文件超过 20 MB，已拒绝导入');
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return decodeUtf16Be(buffer.subarray(2));
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.length >= 4 && buffer[0] === 0x3c && buffer[1] === 0x00) return buffer.toString('utf16le');
  if (buffer.length >= 4 && buffer[0] === 0x00 && buffer[1] === 0x3c) return decodeUtf16Be(buffer);
  return buffer.toString('utf8');
}

function parseXml(xml) {
  if (Buffer.byteLength(xml, 'utf8') > MAX_FILE_BYTES * 3) throw new Error('NCX 解码后的 XML 超过允许大小');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('NCX 文件不允许包含 DTD 或 ENTITY 实体声明');

  const document = { name: '#document', attrs: {}, children: [], content: '' };
  const stack = [document];
  let nodeCount = 0;
  const parser = sax.parser(true, { trim: false, normalize: false, lowercase: false });
  parser.onopentag = (tag) => {
    nodeCount += 1;
    if (nodeCount > MAX_NODES) throw new Error('NCX XML 节点过多');
    if (stack.length > MAX_DEPTH) throw new Error('NCX XML 嵌套过深');
    const attrs = {};
    for (const [name, value] of Object.entries(tag.attributes || {})) attrs[name] = String(value);
    const node = { name: tag.name, attrs, children: [], content: '', parent: stack[stack.length - 1] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  };
  parser.ontext = (value) => {
    const node = stack[stack.length - 1];
    if (node.content.length < 8192) node.content += String(value).slice(0, 8192 - node.content.length);
  };
  parser.oncdata = parser.ontext;
  parser.onclosetag = () => { if (stack.length > 1) stack.pop(); };
  try {
    parser.write(xml).close();
  } catch (error) {
    throw new Error(`NCX XML 解析失败：${error.message}`);
  }
  return document;
}

function typeFrom(value) {
  const raw = normalizedKey(value);
  if (!raw) return null;
  if (raw.includes('oceanbaseoracle') || raw === 'oboracle') return 'oboracle';
  if (raw.includes('oceanbase')) return 'oceanbase';
  if (raw.includes('mariadb') || raw.includes('mysql')) return 'mysql';
  if (raw.includes('postgres')) return 'postgres';
  if (raw.includes('sqlserver') || raw.includes('mssql')) return 'mssql';
  if (raw.includes('sqlite')) return 'sqlite';
  if (raw.includes('clickhouse')) return 'clickhouse';
  return null;
}

function attributeMap(node) {
  const result = {};
  for (const [name, value] of Object.entries((node && node.attrs) || {})) {
    const key = normalizedKey(name);
    if (!(key in result)) result[key] = value;
  }
  return result;
}

function firstValue(node, aliases, includeChildren = true) {
  const attrs = attributeMap(node);
  for (const alias of aliases) {
    const value = attrs[normalizedKey(alias)];
    if (value !== undefined && cleanText(value)) return value;
  }
  if (!includeChildren) return '';
  for (const child of node.children || []) {
    if (aliases.some((alias) => normalizedKey(alias) === normalizedKey(child.name))) {
      const childAttrs = attributeMap(child);
      return childAttrs.value || childAttrs.val || cleanText(child.content);
    }
  }
  return '';
}

function rawTypeFor(node) {
  const aliases = ['type', 'conntype', 'connectiontype', 'servertype', 'dbtype', 'databaseType'];
  let current = node;
  while (current && current.name !== '#document') {
    const explicit = firstValue(current, aliases);
    if (explicit) return explicit;
    if (typeFrom(current.name)) return current.name;
    current = current.parent;
  }
  return '';
}

function groupFor(node) {
  let current = node.parent;
  while (current && current.name !== '#document') {
    if (normalizedKey(current.name) === 'group') {
      return cleanText(firstValue(current, ['name', 'groupname'], false), 128);
    }
    current = current.parent;
  }
  return cleanText(firstValue(node, ['group', 'groupname', 'folder', 'foldername'], false), 128);
}

function findSshNode(node) {
  const queue = [...(node.children || [])];
  while (queue.length) {
    const current = queue.shift();
    if (normalizedKey(current.name).includes('ssh')) return current;
    queue.push(...(current.children || []));
  }
  return null;
}

function decryptField(node, aliases) {
  const encrypted = cleanText(firstValue(node, aliases), 16384);
  if (!encrypted) return { plaintext: '', imported: 0 };
  const result = decryptNavicatSecret(encrypted);
  return { plaintext: result.plaintext, imported: 1 };
}

function mapSsh(node) {
  const sshNode = findSshNode(node);
  const source = sshNode || node;
  const prefixed = (name) => sshNode ? [name] : [`ssh${name}`];
  const enabledValue = firstValue(source, prefixed('enabled'));
  const host = cleanText(firstValue(source, prefixed('host')));
  const user = cleanText(firstValue(source, [...prefixed('username'), ...prefixed('user')]));
  const keyFile = cleanText(firstValue(source, [
    ...prefixed('privatekeyfile'), ...prefixed('keyfile'), ...prefixed('privatekey'),
  ]), 2048);
  const authRaw = cleanText(firstValue(source, [...prefixed('authentication'), ...prefixed('authtype')]));
  const enabled = asBool(enabledValue, !!(host || user || keyFile));
  if (!enabled) return { ssh: null, secretCount: 0 };
  const password = decryptField(source, prefixed('password'));
  const passphrase = decryptField(source, prefixed('passphrase'));
  return { ssh: {
    enabled: true,
    host,
    port: asPort(firstValue(source, prefixed('port')), 22),
    user,
    authType: keyFile || /key|public/i.test(authRaw) ? 'key' : 'password',
    keyFile,
    password: password.plaintext,
    passphrase: passphrase.plaintext,
  }, secretCount: password.imported + passphrase.imported };
}

function mapConnection(node, type) {
  const name = cleanText(firstValue(node, ['connectionname', 'displayname', 'name', 'caption']), 128)
    || `${type.toUpperCase()} 连接`;
  const group = groupFor(node);
  if (type === 'sqlite') {
    return { config: {
      type,
      name,
      file: cleanText(firstValue(node, ['databasefile', 'databasefilename', 'filename', 'filepath', 'database', 'path']), 2048),
      group,
      env: '',
      color: '',
      password: '',
    }, secretCount: 0 };
  }

  const password = decryptField(node, ['password', 'passwd', 'pwd']);
  const config = {
    type,
    name,
    host: cleanText(firstValue(node, ['host', 'hostname', 'server', 'serverhost', 'ip'])),
    port: asPort(firstValue(node, ['port', 'serverport']), DEFAULT_PORTS[type]),
    user: cleanText(firstValue(node, ['username', 'user', 'userid', 'loginname'])),
    password: password.plaintext,
    database: cleanText(firstValue(node, ['database', 'databasename', 'initialcatalog', 'schema'])),
    group,
    env: '',
    color: '',
    options: {},
  };
  if (type === 'mssql') {
    config.options.encrypt = asBool(firstValue(node, ['encrypt', 'useencryption', 'ssl']));
    config.options.trustCert = asBool(firstValue(node, ['trustservercertificate', 'trustcert']), true);
  }
  if (type === 'clickhouse') {
    config.options.https = asBool(firstValue(node, ['https', 'usessl', 'ssl']));
  }
  const sshResult = mapSsh(node);
  if (sshResult.ssh) config.ssh = sshResult.ssh;
  return { config, secretCount: password.imported + sshResult.secretCount };
}

function parseNcxText(xmlInput, enforceInputSize) {
  const xml = String(xmlInput === undefined || xmlInput === null ? '' : xmlInput).trim();
  if (!xml) throw new Error('NCX 文件为空');
  if (enforceInputSize && Buffer.byteLength(xml, 'utf8') > MAX_FILE_BYTES) {
    throw new Error('NCX 文件超过 20 MB，已拒绝导入');
  }
  const document = parseXml(xml);
  const connections = [];
  const skipped = [];
  const warnings = [];
  let passwordImported = 0;
  let passwordFailed = 0;
  const queue = [...document.children];
  while (queue.length) {
    const node = queue.shift();
    const nodeName = normalizedKey(node.name);
    if (['connection', 'connectioninfo', 'profile'].includes(nodeName)) {
      const rawType = rawTypeFor(node);
      const type = typeFrom(rawType);
      if (!type) {
        skipped.push({
          name: cleanText(firstValue(node, ['connectionname', 'displayname', 'name']), 128) || '未命名连接',
          type: cleanText(rawType) || '未知',
          reason: '不支持的数据库类型',
        });
      } else if (connections.length >= MAX_CONNECTIONS) {
        throw new Error(`NCX 连接数量超过 ${MAX_CONNECTIONS} 个`);
      } else {
        try {
          const mapped = mapConnection(node, type);
          connections.push(mapped.config);
          passwordImported += mapped.secretCount;
        } catch (error) {
          passwordFailed += 1;
          skipped.push({
            name: cleanText(firstValue(node, ['connectionname', 'displayname', 'name']), 128) || '未命名连接',
            type: cleanText(rawType) || type,
            reason: `密码自动解密失败：${error.message}`,
          });
        }
      }
    }
    queue.push(...(node.children || []));
  }
  if (passwordImported) warnings.push(`已自动解密 ${passwordImported} 项数据库或 SSH 凭据，并将在导入时安全保存。`);
  if (passwordFailed) warnings.push(`${passwordFailed} 个连接的密码无法自动解密，已跳过。`);
  if (skipped.length) warnings.push(`共跳过 ${skipped.length} 个无法导入的连接。`);
  return { connections, skipped, warnings, passwordImported, passwordFailed };
}

function parseNcx(xmlInput) {
  return parseNcxText(xmlInput, true);
}

function parseNcxBuffer(buffer) {
  return parseNcxText(decodeNcxBuffer(buffer), false);
}

function targetLabel(connection) {
  if (!connection) return '';
  if (connection.type === 'sqlite') return connection.file || '未指定文件';
  const host = connection.host || '未指定主机';
  const port = connection.port ? `:${connection.port}` : '';
  const database = connection.database ? `/${connection.database}` : '';
  return `${host}${port}${database}`;
}

module.exports = { parseNcx, parseNcxBuffer, targetLabel, MAX_FILE_BYTES };
