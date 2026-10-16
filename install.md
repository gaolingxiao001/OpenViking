# 安装 lark-daemon

这份文档只讲把 daemon 跑起来。想先了解它解决什么问题，读 [README](./README.md)。

## 准备

- Node.js 22.19.0 或以上；clone 后运行 `npm run setup`，自动安装 lockfile 锁定的依赖和项目专用 Pi，并检查 Pi 版本。
- 飞书实例需要已配置 bot profile 的 `lark-cli`；微信单聊 MVP 不需要 `lark-cli`。
- 一个 coding agent：默认支持 Codex，也可以使用 TraeX、Claude、Pi 或火山方舟 Managed Agent。
- 正式常驻运行需要 `pm2`：`npm i -g pm2`。
- OpenViking（可选），用来保存跨会话上下文。要用时每个 agent 在 deployment manifest 中配置自己的 `ovConfig`；不配则该实例没有跨会话记忆，切换 runtime 时开空会话，并会关掉用户全局装的 OV 记忆插件（`OPENVIKING_MEMORY_ENABLED=0`）。
- 全量测试需要 `python3` 为 Python 3.10 或以上，并安装 PyYAML（会议 ASR 用例使用）；实际会议功能的依赖见 `meeting-asr/requirements.txt`。

Codex、TraeX、Claude、Pi 都要先完成各自 CLI 登录。方舟只支持 Self-hosted Managed Agent，需要 `ARK_API_KEY` 和已绑定 Agent、Environment 的 seed session；完整字段看 [deployment.example.json](./deployment.example.json)。

Claude Code 需要 2.1.259 或以上，支持 `--permission-prompts none`；启动预检会检查该参数。daemon 是无人值守会话：Pi 扩展对话框、Codex/TraeX 的审批和用户输入请求会被明确取消或拒绝；Claude 使用官方无人值守设置，并拒绝意外的控制请求。需要向人提问时，模型应通过消息工具发文字或支持的选项卡，结束当前轮次，再等待用户消息或卡片答案。用户的扩展、provider 和其他会话配置不因此被关闭。

Pi 1.2.0 在启动扩展完成后才开始读取 RPC 回复，因此扩展在 `session_start` 中要求人工输入时，daemon 会立即拒绝启动并提示关闭该启动交互；运行期间的对话框则正常返回取消。

Pi 随项目依赖自动安装，确切版本由 `packages/daemon/package.json` 和 lockfile 固定。用 `npm run pi` 打开项目专用 Pi，再执行 `/login`；已有 Pi 的模型登录信息仍可复用。安装不会升级全局 `pi`。`PI_BIN` 留空时使用项目/release 内的版本；显式指定其他路径时，该程序必须是本 release 验证的同一版本，否则启动会给出修复指引。

daemon 启动 Pi 时只为该会话注册 `personal_agent` MCP server，使用 `direct` exposure，让模型直接看到各个工具和参数。它不会修改 `~/.pi/agent/mcp.json` 或工作区 `.pi/mcp.json`，也不会给用户其他 Pi 会话添加该 server。若这些文件已有同名 server、内置 MCP 被禁用，或工具没有成功加载，daemon 会拒绝启动 Pi；不回退到 Bash/CLI。普通用户的其他 MCP server 配置仍由 Pi 自己加载。

## 配飞书

1. 在飞书开放平台创建 bot，在「事件配置」中开启长连接订阅 `im.message.receive_v1`；在独立的「回调配置」中开启长连接并添加 `card.action.trigger`。只订阅消息事件可以收到卡片正文，但收不到按钮点击。
2. 导入仓库根目录的 [permission.json](./permission.json)，发布应用并完成权限审核。
3. 把 bot 加入你信任的聊天，并限制应用可见范围。群里不 @ 也要收消息时，记得开 `im:message.group_msg`。
4. 用 `lark-cli` 配好 bot profile。只有要以用户身份读个人资源时，才额外做 OAuth 登录。

文档上传需要 `im:resource`，发送需要 `im:message:send_as_bot`，读取卡片需要 `im:message:readonly`，更新已回答卡片需要 `im:message:update`；仓库权限清单已包含这些 scope。请使用支持 `card.action.trigger` 的 lark-cli（本实现按 1.0.94 的命令与事件 schema 验证）。CLI 能正常启动不代表开放平台已启用卡片回调，该控制台配置仍须核对。无需额外公网回调地址，CLI 会及时自动 ACK，模型随后异步处理答案。

`permission.json` 是完整能力清单，不是最小权限集；正式环境按实际用途收窄权限和可见范围。

## 本地启动

```bash
git clone <repo-url> lark-daemon
cd lark-daemon
mkdir -p ~/.lark-daemon
cp deployment.example.json ~/.lark-daemon/deployment.json
# 编辑 deployment.json：至少填 profile（飞书实例）、dataDir、workspace、model；要用 OV 再填 ovConfig
npm run setup
npm test && npm run check
npm run start:daemon
```

默认配置是 `~/.lark-daemon/deployment.json`。如需放在其他位置，给所有启动、部署和升级命令设置同一个绝对路径的 `LARK_DAEMON_DEPLOYMENT_MANIFEST`。

### 微信扫码与单聊链路

给微信单独增加一个 agent 时，设置 `"channel": "weixin"`、`"connectors": ["weixin"]`，`model` 可选 Codex、TraeX、Claude 或 Pi（方舟的工具执行在 Worker 里，访问不到 Core 的 Agent 工具，不支持微信），并使用独立的 `port`、`dataDir`、`workspace`（用 OV 时再加独立的 `ovConfig`）。要让一个实例的 session 和 OV 同时接收飞书和微信，保留 `"channel": "lark"` 并设置 `"connectors": ["lark", "weixin"]`。纯微信实例不填 `profile`，填了会被拒绝。完整片段见 [README 的微信单聊 MVP](./README.md#微信单聊-mvp)。

```bash
npm run weixin:login -- weixin
LARK_DAEMON_INSTANCE_ID=weixin npm run start:daemon
```

登录命令按实例读取 manifest，在终端输出二维码。手机确认后，token、机器人账号、扫码用户和长轮询游标保存在该实例的私有 SQLite 中。Core 随后启动独立微信 Connector；它调用 `notifyStart`，持续请求 `getupdates`，把入站文本、图片、文件和微信已有语音转写封装成 `EVENT` 交给 Agent。媒体保存在 `dataDir/weixin/media`。Agent 通过统一的 Agent 工具（Codex/TraeX/Claude/Pi 共用 MCP 适配器）把查询和发送请求经 `dataDir/actions.sock` 交给 Core；Core 先写 outbox，再由 Connector 携带 `context_token` 和由幂等键派生的 `client_id` 调用 `sendmessage`。

默认 allowlist 是扫码用户。`LARK_DAEMON_WEIXIN_ALLOW_FROM` 可配置逗号分隔的完整 iLink 用户 ID；不要填昵称。会话过期（`ret=-14`）时只有微信 Connector 停下，飞书照常工作；Core 按 5 秒、15 秒、1 分钟、之后每 5 分钟的间隔重试。重新运行扫码命令即可，下一次重试会用上新登录，不需要重启实例。当前支持微信单聊文本、图片、文件和微信已有语音转写；不处理原始语音、视频或群聊。

### 方舟 Self-hosted Managed Agent

这是当前唯一支持且建议的 MA 接入方式，因为只有 Self-hosted Environment 能在同一个原生 turn 中多次调用 Environment 内的本机 CLI。云沙箱的严格 JSON `agent.message` Tool Call bridge 已移除。理论上可把 CLI credential 同步到云沙箱重建类似链路，但目前不建议这样接入。

在目标 agent 中设置 `model: "ark"`，用 `volcSessionId` 指向已绑定 Agent 与 Self-hosted Environment 的 seed session，并用 `volcEnvironmentId` 锁定同一个 Environment。部署层会分别注入 `LARK_DAEMON_VOLC_SESSION_ID` 和 `LARK_DAEMON_VOLC_ENVIRONMENT_ID`；其他 bot 不会继承这组 ID。daemon 启动时会校验 Environment ID 与 `config.type=self_hosted`，不匹配时 fail closed。每个 daemon 实例会从 seed 创建自己的 session，不会共同写 seed session；`ARK_API_KEY` 只放在进程环境中。参考已验证的 [Self-hosted Environment](https://console.volcengine.com/ark/region:cn-beijing/managed-agents/environments/env-20260831031839-rm2nj?searchField=Name)。

此外要独立常驻官方 Go `EnvironmentWorker`，并给 Worker 设置 `ARK_API_KEY`、`ARK_BASE_URL`、`MA_ENVIRONMENT_ID` 和对应 bot 的 `LARKSUITE_CLI_PROFILE`。Managed Agent 通过 Worker 的 bash 调固定本机 `lark-cli` 完成回复；daemon 只负责 Sessions API/SSE，不执行工具、不回写 tool result，也不要求本轮必须返回 `agent.message`。因此仅通过 CLI 完成回复、随后直接 `end_turn` 也是成功路径。Worker 的部署、存活与升级暂不由 daemon/updater 托管。

## 正式部署与升级

首次上线：

```bash
./scripts/deploy.sh HEAD
./scripts/bootstrap-updater.sh
lark-daemon upgrade all
```

平时先把 commit push 到 upstream `main`，再升级：

```bash
lark-daemon upgrade <instance-id>
# 共享 Web 有改动时
lark-daemon upgrade all
```

首次发布和自动升级都会先在新 release 内执行 `npm ci`、验证托管 Pi，再运行测试；全部成功后才切换 release 和进程。升级 Pi 也是更新版本锁定后随 release 发布，回滚则使用旧 release 自己的 Pi。安装或验证失败不会覆盖当前 release 的依赖，也不会修改用户全局 Pi。

从尚未安装 release 依赖的旧 updater 迁移时，首次需使用新代码执行上面的 `deploy.sh HEAD` 和 `bootstrap-updater.sh`，再调用 upgrade。旧 updater 的验证逻辑不会自动执行新代码中的依赖安装；控制面更新后，后续升级自动安装目标 release 锁定的 Pi。

`deploy.sh` 只用于首次安装或 updater 协议变更。查看运行状态：

```bash
pm2 status lark-daemon-<instance-id> lark-web lark-updater
curl http://127.0.0.1:3737/ready
```

只要还有一个 Connector 在运行，`/ready` 就返回 200；有 Connector 不可用时，body 的 `status` 是 `degraded`，`connectors.<id>` 带上 `error` 和下次重试时间 `retryAt`。

## 多个 agent

在 `deployment.json` 的 `agents` 增加 agent。每个 agent 都要使用独立的 id、端口、dataDir、workspace，飞书实例还要独立的 profile，用 OV 时还要独立的 OV 配置；它们共享 release、Web 与 updater。`channel` 保留单 Connector 兼容行为；可选 `connectors` 数组允许一个 Core 同时启动 `lark` 和 `weixin`。省略两者时走飞书。改动拓扑后，重新执行 `deploy.sh HEAD`、`bootstrap-updater.sh` 和 `lark-daemon upgrade all`。
