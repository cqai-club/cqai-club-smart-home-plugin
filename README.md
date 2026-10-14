# CQAI Club 家庭智能

DSH / e宝工坊插件，在桌面侧栏提供独立的「家庭智能」入口。插件管理本机 Python 与 Home Assistant Core，展示匹配版本的官方 Home Assistant 完整界面，并向现有 DSH Agent 提供设备查询、控制与环境诊断工具。

默认模式下，不需要填写 HA 地址、API Key 或复制 Token。首次启动自动下载运行环境、创建本地账户、完成官方 onboarding 与授权。品牌设备的登录、网关、配对码和硬件仍需在 Home Assistant 的「设置 → 设备与服务」中完成。

## 当前版本

- 插件：0.1.1；目标 Host：DSH `0.2.0-rc.2` / e宝工坊 Beta。
- 已验证平台：macOS arm64，Node 24；Python `3.14.2`、HA Core `2026.10.1`、由 HA 安装其 manifest 指定的 frontend `20260930.3`。
- 原生 Python 部署由本插件维护。HA Core 代码仍由官方维护，但这种安装方式已不在 HA 官方支持的安装方式内。
- 不安装 HA OS、Supervisor 或 Docker。HA OS 的应用商店 / Add-ons 不在本插件范围内。
- 原生 Windows 暂不支持；Linux 尚未进行实际验收。外部模式可连接用户已有的 HA。

本机默认启用界面、设备管理、自动化、历史记录及网络发现等基础组件。HA 内置语音助手、Nabu Casa 和 go2rtc 不在首次启动时自动初始化；品牌云设备仍通过各品牌集成接入。

0.1.1 修复首次建户等待组件时被 30 秒超时中断的问题：建户使用独立长超时，已创建的托管 owner 经原密码验证后复用，由 HA 在重启时补齐初始化状态。过期且完全匹配托管地址的 HTTP 试用配置可通过 HA 官方存储 API 恢复，始终限定 127.0.0.1。保留现有账户及数据。

## 使用

npm 包：[`@cqaiclub/cqai-club-smart-home-plugin`](https://www.npmjs.com/package/@cqaiclub/cqai-club-smart-home-plugin)。在 e宝工坊的插件安装入口填写此包名，或从 CQAI Club 插件市场安装「家庭智能」。

安装本插件 bundle 后，打开桌面左侧「家庭智能」。首次联网安装需要数分钟，页面显示安装步骤；成功后自动展示完整 HA 界面。

三个页面：

1. **家庭面板**：完整 HA 界面、运行状态、启动/停止、刷新界面。
2. **环境与备份**：诊断、重启、重建独立 Python 环境、创建与恢复本地备份。恢复前自动创建当前配置快照；后续失败会回滚。
3. **连接设置**：家庭名称、时区、自动启动；高级设置中可修改受控版本或连接外部 HA。修改版本前创建备份，安装或认证失败恢复原设置与配置。

停止 / 卸载插件和关闭 Host 会停止其管理的 HA 进程。后台自动化需要 Host 和 HA 保持运行。

可向现有 DSH Agent 提问「列出已接入的灯」「检查家庭智能运行环境」。控制工具只处理明确指定的实体，禁止默认操作全屋。门锁解锁、报警解除、未知服务以及环境修复通过 Host 的批准流程；没有批准通道时拒绝执行。

涂鸦等云集成仍可能需要厂商账户登录/扫码；Aqara 的接入方式取决于具体设备和网关。Zigbee 需要兼容协调器/网关，Matter/Thread 需要相应服务器与边界路由器，浏览器不能替代全部配对流程。这些外围服务没有随当前插件自动安装。

## 本地数据与认证

默认数据目录为 `$DSH_HOME/data/cqai-club-smart-home`；没有 DSH_HOME 时为 `~/.dsh/data/cqai-club-smart-home`。插件配置的 `dataDir` 可指定独立绝对路径。

```text
config/       HA 配置、数据库、集成与 HA 自身账户存储
environment/  插件独立 Python 虚拟环境
python/       uv 管理的 Python
state/        插件设置、持久端口与必要认证状态
backups/      配置与授权的一致快照
logs/         本地脱敏诊断日志
cache/        依赖缓存
```

有 Host credentials 服务时，插件凭证保存在其 grant record；否则使用权限为 0600 的私有 JSON 文件。目录权限为 0700。备份包含授权资料，同样仅限本机用户访问；当前备份不额外加密。

长效授权、账户密码不会进入公开状态、前端设置回填或模型工具输出。嵌入 HA 前端使用短期 access token，长效凭证留在后端。点击 HA 中退出会关闭当前嵌入会话；从插件重新打开界面会重新授权，停止插件请使用运行管理按钮。

入口限定为 `http://127.0.0.1:<Host 端口>`。Host 管理 API 使用 JSON POST 与来源检查；HA 完整界面通过一次性、60 秒有效的入口进入独立 loopback 网关，并受会话、WebSocket Origin 和 frame-ancestors 限制。使用 Chrome 打开桌面的本机地址也可查看；LAN / 公网访问不在当前版本范围内。

在 HA 网络设置中修改托管实例的 HTTP 监听地址/端口会使插件诊断为不一致。通过插件管理运行环境，避免与其它实例共用数据目录；原有 HA 实例使用外部模式连接。

## 开发与验证

```sh
corepack pnpm install
corepack pnpm check
corepack pnpm smoke:host
```

需要 Node `^22.19.0 || >=24.0.0`，开发验收使用 Node 24。`smoke:managed` 只使用项目 `.local/smoke` 空实例，不调用设备服务；加 `--serve` 可保持浏览器验证页面。真实安装下载依赖需要网络。

CI 的 `smoke:host` 使用当前项目的公共 DSH npm 依赖和模拟设备，在临时目录中验证打包后的 Host 与客户端，不需要相邻源码仓库或真实 HA。

```sh
corepack pnpm smoke:managed --serve
```

`cordis.patch.yml` 是 bundle 入口，Node 主模块位于 `lib/index.js`，浏览器模块位于 `lib/client.js`。外部模式的令牌通过插件内设置保存，不放入 bundle / package.json。

## 开源来源

[Home Assistant Core](https://github.com/home-assistant/core) 和 [官方 frontend](https://github.com/home-assistant/frontend) 是运行时依赖，保持其 Apache-2.0 许可；本插件原创封装代码采用 MIT。详见 THIRD_PARTY_NOTICES.md。

## 发布与插件市场

GitHub Actions 在提交及 PR 时检查构建与包产物；推送 `v<版本>` 标签触发 npm 发布和 GitHub Release。首次发布后可配置 npm Trusted Publisher，让后续版本从 GitHub 自动发布。详见 [发布说明](docs/releasing.md)。

[`market-entry.json`](market-entry.json) 是可导入 CQAI Club 插件市场的完整条目。导入方法和固定版本安装示例见 [市场配置说明](docs/marketplace.md)。
