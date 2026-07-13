const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'css', 'app.css'), 'utf8');
const contextMenu = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'contextmenu.js'), 'utf8');
const connDialog = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'connDialog.js'), 'utf8');
const toast = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'toast.js'), 'utf8');
const tree = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'tree.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
const ipc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc.js'), 'utf8');
const util = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'util.js'), 'utf8');

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, ' ');
}

const buttons = rule('.modal-foot .btn');
assert.match(buttons, /flex-shrink:\s*0/);
assert.match(buttons, /white-space:\s*nowrap/);

const result = rule('.test-result');
assert.match(result, /flex:\s*1\s+1\s+0/);
assert.match(result, /min-width:\s*0/);
assert.match(result, /max-height:\s*\d+px/);
assert.match(result, /overflow:\s*auto/);
assert.match(result, /overflow-wrap:\s*anywhere/);

assert.match(rule('.test-result:empty'), /display:\s*none/);
assert.match(rule('.test-result:not(:empty) + .spring'), /display:\s*none/);

const menuItem = rule('.ctx-item');
assert.match(menuItem, /padding:\s*6px\s+12px/);
assert.match(contextMenu, /const hasIcons = items\.some/);
assert.match(contextMenu, /hasIcons \? ' has-icons' : ''/);
assert.match(contextMenu, /if \(hasIcons\) \{/);
assert.doesNotMatch(contextMenu, /style:\s*\{\s*display:\s*'inline-flex',\s*width:\s*'14px'/);

const menuIcon = rule('.ctx-icon');
assert.match(menuIcon, /flex:\s*0\s+0\s+14px/);
assert.match(menuIcon, /width:\s*14px/);

const formGrid = rule('.form-grid');
assert.match(formGrid, /grid-template-columns:\s*64px\s+minmax\(0,\s*1fr\)/);

assert.match(connDialog, /f\.savePassword\.checked\s*=\s*isEdit\s*\?\s*cfg\.savePassword\s*!==\s*false\s*:\s*false/);
assert.match(connDialog, /class:\s*'password-save-check'/);
assert.match(connDialog, /out\.savePassword\s*=\s*f\.savePassword\.checked/);
assert.match(connDialog, /新建连接采用安全默认值/);
const passwordSaveCheck = rule('.form-grid .password-save-check');
assert.match(passwordSaveCheck, /flex:\s*0\s+0\s+auto/);
assert.match(passwordSaveCheck, /white-space:\s*nowrap/);
assert.match(passwordSaveCheck, /text-align:\s*left/);
assert.match(toast, /export function passwordDialog/);
assert.match(toast, /type:\s*'password'/);
assert.match(tree, /r\s*&&\s*r\.needsPassword/);
assert.match(tree, /passwordDialog\(/);
assert.match(preload, /\{\s*connId,\s*password\s*\}/);
assert.match(connDialog, /const shouldOpen\s*=\s*!state\.open\.has\(saved\.id\)/);
assert.match(connDialog, /openConnectionById\(saved\.id\)/);
assert.match(ipc, /const result\s*=\s*await dbm\.open\(store\.getById\(connId\)\)/);
assert.match(ipc, /store\.clearSessionPassword\(connId\)/);

const databaseIcons = ['mysql', 'postgres', 'sqlite', 'mssql', 'clickhouse', 'oceanbase', 'oboracle'];
const iconBodies = databaseIcons.map((name) => {
  const match = util.match(new RegExp(`${name}:\\s*svg\\(\`([\\s\\S]*?)\`\\),`));
  assert.ok(match, `Missing database icon: ${name}`);
  return match[1].replace(/\s+/g, ' ');
});
assert.strictEqual(new Set(iconBodies).size, databaseIcons.length, 'Database icons must be visually distinct');
assert.doesNotMatch(iconBodies[0], /<rect/, 'MySQL should use a clear standalone dolphin silhouette');
assert.doesNotMatch(iconBodies[1], /<rect/, 'PostgreSQL should use a clear standalone elephant silhouette');
assert.match(rule('.tree-icon'), /width:\s*18px/);
assert.match(rule('.tree-icon svg'), /width:\s*18px/);
assert.match(rule('.conn-closed > .tree-row .tree-icon svg'), /grayscale\(1\)/);
assert.match(rule('.conn-closed > .tree-row .tree-icon svg'), /opacity:\s*0\.52/);
assert.match(rule('.tree-node[data-conn] > .tree-row .tree-icon::after'), /width:\s*6px/);

console.log('Dialog footer layout checks passed');
