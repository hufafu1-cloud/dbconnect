// 默认直连 GitHub Releases，不依赖可能返回 403 的公共代理。
// Windows 标准版 latest.yml，兼容版 win7.yml；Linux 由 updater 添加平台/架构后缀。
//
// 环境变量覆盖：
// - DBPANDA_UPDATE_URL=https://host/path/     完全自定义 generic 地址（内网等）
// - DBPANDA_UPDATE_PROXY=https://gh-proxy.com/ 自定义代理前缀；设为 0/off/direct 则直连 GitHub
// - DBPANDA_UPDATE_OWNER / DBPANDA_UPDATE_REPO     改仓库
const DEFAULT_OWNER = 'hufafu1-cloud';
const DEFAULT_REPO = 'dbconnect';
const DEFAULT_PROXY_PREFIX = '';

// 构建时写入发行变体；不能根据当前 OS 自动换通道（兼容版也可能运行于 Win10）。
function getUpdateChannel(pkg = require('../../package.json')) {
  return pkg.releaseVariant === 'win7-x64' ? 'win7' : 'latest';
}

// 即使镜像误放了清单，也不能把标准版安装到 Win7 或跨架构安装。
function validateUpdateInfo(info, pkg = require('../../package.json'), platform = process.platform, arch = process.arch) {
  const allowed = platform === 'win32' && arch === 'x64'
    ? [getUpdateChannel(pkg) === 'win7' ? 'DBPanda-Win7-x64-Setup.exe' : 'DBPanda-Setup.exe']
    : platform === 'linux' && ['x64', 'arm64'].includes(arch)
      ? (arch === 'x64'
        ? ['DBPanda-Linux-x86_64.AppImage', 'DBPanda-Linux-amd64.deb']
        : ['DBPanda-Linux-arm64.AppImage', 'DBPanda-Linux-arm64.deb']) : [];
  const files = info && info.files;
  if (!allowed.length || !Array.isArray(files) || !files.length || files.some(f => !allowed.includes(f.url))) {
    throw new Error('更新清单与当前平台/发行版不匹配，已阻止下载，请检查更新源');
  }
}

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
      channel: getUpdateChannel(),
      url: customUrl.replace(/\/+$/, '') + '/',
    };
  }

  const owner = String(process.env.DBPANDA_UPDATE_OWNER || DEFAULT_OWNER).trim();
  const repo = String(process.env.DBPANDA_UPDATE_REPO || DEFAULT_REPO).trim();
  const proxy = process.env.DBPANDA_UPDATE_PROXY;

  // 走 generic +（可选）代理，避免 github provider 请求 api.github.com 被墙
  return {
    provider: 'generic',
    channel: getUpdateChannel(),
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
  validateUpdateInfo,
  getUpdateChannel,
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
