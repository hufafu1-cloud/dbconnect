// 自动更新默认经 gh-proxy 访问 GitHub Releases（国内直连 GitHub 常失败）。
// 实际拉取：
//   https://gh-proxy.com/https://github.com/<owner>/<repo>/releases/latest/download/latest.yml
//   以及同目录下的安装包。
//
// 环境变量覆盖：
// - DBPANDA_UPDATE_URL=https://host/path/     完全自定义 generic 地址（内网等）
// - DBPANDA_UPDATE_PROXY=https://gh-proxy.com/ 自定义代理前缀；设为 0/off/direct 则直连 GitHub
// - DBPANDA_UPDATE_OWNER / DBPANDA_UPDATE_REPO     改仓库
const DEFAULT_OWNER = 'hufafu1-cloud';
const DEFAULT_REPO = 'dbconnect';
const DEFAULT_PROXY_PREFIX = 'https://gh-proxy.com/';

function normalizeProxyPrefix(raw) {
  const value = String(raw == null ? DEFAULT_PROXY_PREFIX : raw).trim();
  if (!value || /^(0|false|off|none|direct)$/i.test(value)) return '';
  return value.replace(/\/+$/, '') + '/';
}

function githubLatestDownloadUrl(owner, repo, proxyPrefix = DEFAULT_PROXY_PREFIX) {
  const githubUrl = `https://github.com/${owner}/${repo}/releases/latest/download/`;
  const prefix = normalizeProxyPrefix(proxyPrefix);
  return prefix ? `${prefix}${githubUrl}` : githubUrl;
}

function getFeedOptions() {
  const customUrl = String(process.env.DBPANDA_UPDATE_URL || '').trim();
  if (customUrl) {
    return {
      provider: 'generic',
      url: customUrl.replace(/\/+$/, '') + '/',
    };
  }

  const owner = String(process.env.DBPANDA_UPDATE_OWNER || DEFAULT_OWNER).trim();
  const repo = String(process.env.DBPANDA_UPDATE_REPO || DEFAULT_REPO).trim();
  const proxy = process.env.DBPANDA_UPDATE_PROXY;

  // 走 generic +（可选）代理，避免 github provider 请求 api.github.com 被墙
  return {
    provider: 'generic',
    url: githubLatestDownloadUrl(owner, repo, proxy === undefined ? DEFAULT_PROXY_PREFIX : proxy),
  };
}

function getUpdateUrl() {
  return getFeedOptions().url;
}

function isConfigured(feed = getFeedOptions()) {
  if (!feed || typeof feed !== 'object') return false;
  if (feed.provider === 'github') return !!(feed.owner && feed.repo);
  if (feed.provider === 'generic') {
    return /^https?:\/\/[^/]+(?:\/|$)/i.test(feed.url || '') && !/your-nginx-host/i.test(feed.url || '');
  }
  return false;
}

module.exports = {
  DEFAULT_OWNER,
  DEFAULT_REPO,
  DEFAULT_PROXY_PREFIX,
  DEFAULT_GITHUB: { provider: 'github', owner: DEFAULT_OWNER, repo: DEFAULT_REPO },
  DEFAULT_UPDATE_URL: getUpdateUrl(),
  githubLatestDownloadUrl,
  getFeedOptions,
  getUpdateUrl,
  isConfigured,
};
