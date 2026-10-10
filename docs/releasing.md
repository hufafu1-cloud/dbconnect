# 多平台发布、下载与自动更新

## 一次发版，四个构建任务

`.github/workflows/release.yml` 使用原生 Windows/Linux x64/Linux ARM64 GitHub 托管 runner。Windows 兼容包在 Windows 2022 上构建，**不是在 Win7 上构建或测试**。

| 变体 | 运行时 | 更新清单 |
|---|---|---|
| windows-x64 | 根目录锁文件中的 Electron 37 | latest.yml |
| win7-x64 | Electron 22.3.27 / 独立锁文件 | win7.yml |
| linux-x64 | 标准运行时 | latest-linux.yml |
| linux-arm64 | 标准运行时 | latest-linux-arm64.yml |

所有任务使用同一份业务代码。CI 在独立 checkout 中写入 `releaseVariant` 和版本号，Win7 替换为 `build/win7` 的依赖树，然后 `npm ci`、重建原生模块、执行 selftest/smoke、打包并校验。ARM64 原生构建避免 SQLite 跨架构 ABI 混用；DEB 使用原生 fpm。

Win7 降级了 SQLite、MongoDB、SQL Server、Oracle 等驱动，并补充 Node 16 的 fetch 和旧版 Electron 文件拖放兼容。旧驱动支持的数据库版本/认证方式需分别验收，不能仅凭安装成功宣称与标准版完全等价。锁文件还检查所有生产依赖声明的 Node 版本，声明兼容不代替运行测试。

## 发布操作

1. 提交代码和锁文件，在 `release-notes.md` 写入新版本的 `## vX.Y.Z 更新日志`，同步根目录 package/package-lock 的版本（例如 `npm version X.Y.Z --no-git-tag-version`）。不要复用已发布的 v2.8.1。
2. 首次启用建议先在 GitHub Actions → Release → Run workflow 运行无发布构建。普通分支的手动运行仅上传 Actions artifacts；**选择版本 tag 手动运行仍会执行发布**。
3. 在 Win7 SP1 x64、指定 UOS/麒麟 x64/ARM64 实机验收 artifacts。确认仓库可使用 `ubuntu-22.04-arm` 托管 runner；若不可用，需要另行配置 ARM64 runner，不能把任务标成成功跳过。
4. 推送新的稳定 tag `vX.Y.Z`。当前流程仅接受稳定三段版本号，不接受 alpha/beta，防止测试包覆盖 latest 下载入口。
5. 四个任务全部成功后，合并并再次校验产物：版本、必需文件、SHA-512、大小及通道。上传到草稿 Release，全部成功后才公开并更新 latest。已有公开版本禁止覆盖；失败的草稿可在修复后重跑。

无需人工上传安装包或填写更新清单，也不需要额外 PAT：发布 job 使用仓库 `GITHUB_TOKEN` 的 contents:write 权限。若仓库组织策略禁用写权限，需管理员允许。当前没有新增代码签名证书，Windows 仍可能弹出未知发布者提示。

## 自动更新行为

启动后的检查以及“检查更新”复用现有下载进度、取消、确认安装交互。下载必须先通过当前变体的清单检查。兼容版即使在 Win10 上运行也继续取 win7.yml，不会自动换标准版；Linux 根据架构取自己的清单，并由包类型选择 DEB/AppImage。禁止降级。

- Windows NSIS：下载 EXE，用户确认后退出安装。ZIP 使用同一 EXE 更新；纯便携用户需手动换 ZIP。
- AppImage：先 `chmod +x`，保存在用户可写目录，正常运行 AppImage（不要把解包目录当安装包）；更新时替换 AppImage。
- DEB：由系统 dpkg/apt 安装，可能请求管理员授权；无授权环境手动下载交管理员安装。
- 离线或 GitHub 无法访问：显示检查/下载错误，不自动切换到不可信代理，不关闭 TLS 验证。

旧 v2.8.1 已安装客户端中仍写着旧代理地址，修改服务器上的新包不能修复它自身的 403。第一次迁移请手动安装新版本，或在启动前设置 `DBPANDA_UPDATE_PROXY=direct`。之后使用新默认源。

## 国内/内网镜像

默认源为 `https://github.com/hufafu1-cloud/dbconnect/releases/latest/download/`。没有预设自有服务器，仓库改动不会自动获得国内 CDN。

可将同一 Release 的全部附件同步到自有 HTTPS 目录，在客户端启动环境设置：

```text
DBPANDA_UPDATE_URL=https://downloads.example.com/dbpanda/stable/
```

镜像必须保留四份 YAML 和原安装包文件名/字节内容；先同步安装包，再原子切换清单（推荐按版本目录上传后切换 stable 指向）。不得把 win7.yml 内容替换成 latest.yml，不要只同步 EXE。SHA-512 校验可检测传输损坏，但不替代可信源和代码签名。

`DBPANDA_UPDATE_PROXY` 保留兼容，默认空；`direct`/`off` 表示直连。`DBPANDA_UPDATE_URL` 优先级更高。下载索引 `downloads.json` 中是对应 tag 的不可变下载链接，方便官网/镜像消费；README 则使用 latest 的固定链接。

## 上线前验收与限制

- 每种目标环境：安装/启动、保存连接、MySQL/PG/SQL Server/SQLite 等实际使用的连接、AI 请求、文件拖放和导出。
- 连续两个测试版本：检查 → 下载 → 取消重试 → 安装 → 版本变化，验证原有配置和密码保留；检查 Win7 不取标准 EXE、ARM64 不取 x64。
- Linux 测试系统密钥环、DEB 提权、AppImage 写权限/FUSE；不要通过禁用沙箱来掩盖部署问题。
- CI 的 Ubuntu 22.04 构建及冒烟测试不证明旧 UOS/麒麟的 glibc、桌面库和厂商策略兼容，需记录准确系统版本和 CPU；不提供 RPM、LoongArch/MIPS、32 位包。
- Electron 22 已停止安全维护；兼容依赖的已知安全风险需单独审核，不能以冻结版本代替维护。现代版也应持续升级运行时。

本地运行 `npm run release:test` 校验通道、清单、防串包及 Win7 Node 引擎约束，`npm run verify` 执行现有完整回归。不要在开发工作区直接运行 `release-profile.js`，它只允许 CI 临时 checkout。
