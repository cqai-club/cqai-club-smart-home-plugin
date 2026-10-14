# 发布与流水线

源码仓库：<https://github.com/cqai-club/cqai-club-smart-home-plugin>。npm 包：`@cqaiclub/cqai-club-smart-home-plugin`。使用 Node.js 24 和 `package.json` 固定的 pnpm 10.34.5。

## 自动检查

`.github/workflows/ci.yml` 对 `main`、`dev`、Pull Request 和手动触发执行：

1. `pnpm install --frozen-lockfile`。
2. TypeScript 检查、隔离测试、构建。
3. `pnpm smoke:host .`，使用项目自身的 DSH 0.2.0-rc.2 依赖、临时数据目录与模拟设备。
4. `node scripts/verify-release.mjs`，生成并审计真实 npm tarball，核对插件市场入口。

测试不会启动真实 Home Assistant，也不会控制真实设备。产物仅包含 `lib/`、插件清单、Cordis 配置及说明和许可证。HA/Python 环境、凭据、数据库、日志与本地 smoke 报告不得进入 npm 包。

## npm Trusted Publisher

首次创建包可在本机执行下文发布步骤。包存在后，在 npm 的包设置中创建 GitHub Actions Trusted Publisher，或使用已登录且满足 npm 2FA 要求的 npm 11.16.0：

```sh
npm trust github @cqaiclub/cqai-club-smart-home-plugin \
  --repository cqai-club/cqai-club-smart-home-plugin \
  --file release.yml \
  --allow-publish
npm trust list @cqaiclub/cqai-club-smart-home-plugin
```

网页配置填写：Organization/user 为 `cqai-club`；Repository 为 `cqai-club-smart-home-plugin`；Workflow filename 为 `release.yml`；Environment 留空；允许 `npm publish`。

发布工作流使用 GitHub 托管的 Ubuntu runner、Node 24、npm 11.16.0、`id-token: write`，并关闭依赖缓存。Trusted Publisher 使用 OIDC；如组织暂未配置 OIDC，也可提供 GitHub Actions secret `NPM_TOKEN` 作为传统认证的备用方式。不要把 token 写入仓库或提交 `.npmrc`。

官方依据：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)、[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)、[npm provenance](https://docs.npmjs.com/generating-provenance-statements/)。Trusted publishing 至少需要 npm 11.5.1 和 Node 22.14；provenance 必须来自公共仓库并匹配包的 `repository.url`。

## 发布版本

更新 `package.json` 和 `dsh.plugin.json` 版本，同步必要的文档和市场入口，提交通过检查的源码，再推送相同版本的标签：

```sh
git tag v0.1.1
git push origin v0.1.1
```

`.github/workflows/release.yml` 也支持手动选择已存在的版本标签。它重新执行检查、模拟 Host smoke 与打包审计；标签必须等于 `v` 加上 `package.json` 版本；发布命令使用审计后的同一个 tarball：

```sh
npm publish .release/cqaiclub-cqai-club-smart-home-plugin-0.1.1.tgz \
  --access public --provenance --ignore-scripts
```

若同版本已由本机发布，流水线仅在 registry 的 SHA512 integrity 与当前审计 tarball 相同的情况下跳过 npm 发布，并继续创建 GitHub Release。若内容不同则失败，必须增加版本号。发布后核对 registry 元数据，并实际下载 npm tarball 比对 SHA512；npm 异步处理造成的 404 最多等待 10 分钟，内容不一致立即失败。验证成功后将 npm tarball、`market-entry.json`、`package-audit.json` 作为 GitHub Release 附件保存。

## 本机首发

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm smoke:host .
node scripts/verify-release.mjs --tag v0.1.1 --check-registry
npm publish .release/cqaiclub-cqai-club-smart-home-plugin-0.1.1.tgz \
  --access public --ignore-scripts
node scripts/verify-release.mjs \
  --verify-published .release/cqaiclub-cqai-club-smart-home-plugin-0.1.1.tgz
```

本机发布使用本机已有 npm 登录态，无法生成 GitHub Actions provenance。后续新版本优先通过标签触发 OIDC 流水线。`--ignore-scripts` 只用于已经完成显式检查并通过审计的 tarball。

## 插件市场入口

仓库根目录 `market-entry.json` 使用 CQAI Club 门户插件市场管理接口的配置格式。npm 包发布成功后，可将该配置作为创建插件条目的请求体；它引用 npm 包名，版本由市场同步 registry 信息时解析。流水线将其作为独立 Release 附件，不包含在安装包内。发布产物并不等于已经导入门户市场，导入后仍须检查同步状态与实际安装流程。
