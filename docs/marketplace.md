# CQAI Club 插件市场配置

根目录 `market-entry.json` 是单个插件的导入配置，可在 CQAI Club 官网「管理 → 插件市场 → 从 JSON 导入」粘贴。投稿流程与管理员上架分开：投稿审核通过后生成草稿，管理员发布后才进入公开目录。

配置沿用官网 `cqai-club-portal/lib/plugin-market.ts` 的 `pluginInputSchema`，包括 npm 包名、展示文案、分类、关键词、仓库、主页与兼容声明。该 schema 严格拒绝未知字段，因此版本和安装命令写在介绍中，不另加 `version`、`source` 或 `installCommand` 字段。`repositoryUrl` 指向 GitHub 源码；安装源由官网转换为 `package: { "registry": "npm", "name": "@cqaiclub/cqai-club-smart-home-plugin" }`。

官网公开目录地址为 `https://cqaiclub.asia/v1/plugins`。CQAI Club 扩展展示目录与 npm 包名，安装由 e宝工坊现有插件管理完成。在插件管理输入：

```text
@cqaiclub/cqai-club-smart-home-plugin
```

使用 DSH CLI 固定安装当前版本：

```sh
dsh plugin add --save-exact @cqaiclub/cqai-club-smart-home-plugin@0.1.1
```

需要 DSH `0.2.0-rc.2`、Node `^22.19.0 || >=24.0.0`，以及 e宝工坊 Beta 提供的 WebServer 和客户端界面服务。`compatibilityHosts` 使用 Beta 宿主包名 `dsh-plugin-desktop-beta`。目录兼容字段属于声明，实际依赖检查以 npm 包的 `peerDependencies` 与 Host 为准。当前已验证的托管平台为 macOS arm64 / Node 24；Windows 托管模式不支持，Linux 尚未完成实际验收。

发布新版本时，同步更新 `market-entry.json` 介绍中的版本与本文的固定安装示例，并先确认 npm 对应版本可以读取和安装，再导入或更新官网条目。市场配置无需凭据，也无需携带 Home Assistant 地址或授权资料。

npm 包名也是 DSH 浏览器模块的注册身份。`package.json`、`dsh.plugin.json`、`cordis.patch.yml`、`src/protocol.ts` 与 `tsdown.config.ts` 的模块 ID 必须一致；Host smoke 应使用同一包名导入 `/client`。本地数据目录、运行环境 owner 标记、凭据存储 key 和面板 ID 保持稳定，以便复用已有托管环境。
