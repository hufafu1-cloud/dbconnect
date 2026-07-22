// 自动更新服务地址：发布前替换为内网 Nginx 上 latest.yml 所在目录。
// 也可以通过 DBPANDA_UPDATE_URL 环境变量覆盖，便于测试不同环境。
const DEFAULT_UPDATE_URL = 'http://172.16.35.63/download/win7/';

function getUpdateUrl() {
  return String(process.env.DBPANDA_UPDATE_URL || DEFAULT_UPDATE_URL).trim().replace(/\/+$/, '') + '/';
}

function isConfigured(url = getUpdateUrl()) {
  return /^https?:\/\/[^/]+(?:\/|$)/i.test(url) && !/your-nginx-host/i.test(url);
}

module.exports = { DEFAULT_UPDATE_URL, getUpdateUrl, isConfigured };
