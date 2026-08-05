// 界面文案入口。
//
// 当前只是把中文原文原样返回——这一步**不做任何翻译**，目的是先把调用点统一起来：
// 以后接入多语言时，只需要在这里挂上词典，不必再逐个文件去抠字面量。
//
// 约定（新代码必须遵守）：
//   用户可见的文案一律写成 t('新建连接…')，不要把中文字面量直接塞进 DOM。
//   日志、异常堆栈、SQL 关键字等非界面文本不需要走 t()。
//
// 存量文案暂不改造：接下来还会新增大量界面，边改边加等于翻两遍。

let dict = null;

/** 挂载词典（后续多语言用）。传 null 恢复为「原样返回」。 */
export function setDictionary(map) {
  dict = map && typeof map === 'object' ? map : null;
}

/**
 * t('共 {n} 行', { n: 12 }) → '共 12 行'
 * 占位符用 {name}，词典缺失时回落到原文，永远不会渲染出空字符串。
 */
export function t(text, vars) {
  const key = String(text);
  let out = dict && Object.prototype.hasOwnProperty.call(dict, key) ? String(dict[key]) : key;
  if (vars) {
    out = out.replace(/\{(\w+)\}/g, (match, name) =>
      (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
  }
  return out;
}
