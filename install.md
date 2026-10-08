# 安装 lark-daemon

这份文档只讲把 daemon 跑起来。想先了解它解决什么问题，读 [README](./README.md)。

## 准备

- Node.js 22.5 或以上；项目没有 npm 依赖，不需要 `npm install`。
- 已配置 bot profile 的 `lark-cli`。
- 一个 coding agent：默认支持 Codex，也可以使用 TraeX、Claude、Pi 或火山方舟 Managed Agent。
- 正式常驻运行需要 `pm2`：`npm i -g pm2`。
- OpenViking，用来保存跨会话上下文。每个 agent 在 deployment manifest 中配置自己的 `ovConfig`。

Codex、TraeX、Claude、Pi 都要先完成各自 CLI 登录。方舟只支持 Self-hosted Managed Agent，需要 `ARK_API_KEY` 和已绑定 Agent、Environment 的 seed session；完整字段看 [deployment.example.json](./deployment.example.json)。

## 配飞书

1. 在飞书开放平台创建 bot，开启长连接订阅 `im.message.receive_v1`。
2. 导入仓库根目录的 [permission.json](./permission.json)，发布应用并完成权限审核。
3. 把 bot 加入你信任的聊天，并限制应用可见范围。群里不 @ 也要收消息时，记得开 `im:message.group_msg`。
4. 用 `lark-cli` 配好 bot profile。只有要以用户身份读个人资源时，才额外做 OAuth 登录。

`permission.json` 是完整能力清单，不是最小权限集；正式环境按实际用途收窄权限和可见范围。

## 本地启动

```bash
git clone <repo-url> lark-daemon
cd lark-daemon
mkdir -p ~/.lark-daemon
cp deployment.example.json ~/.lark-daemon/deployment.json
# 编辑 deployment.json：至少填 profile、dataDir、workspace、ovConfig、model
npm test && npm run check
npm run start:daemon
```

默认配置是 `~/.lark-daemon/deployment.json`。如需放在其他位置，给所有启动、部署和升级命令设置同一个绝对路径的 `LARK_DAEMON_DEPLOYMENT_MANIFEST`。

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

`deploy.sh` 只用于首次安装或 updater 协议变更。查看运行状态：

```bash
pm2 status lark-daemon-<instance-id> lark-web lark-updater
curl http://127.0.0.1:3737/ready
```

## 多个 agent

在 `deployment.json` 的 `agents` 增加 agent。每个 agent 都要使用独立的 id、Lark profile、端口、dataDir、workspace 和 OV 配置；它们共享 release、Web 与 updater。改动拓扑后，重新执行 `deploy.sh HEAD`、`bootstrap-updater.sh` 和 `lark-daemon upgrade all`。
