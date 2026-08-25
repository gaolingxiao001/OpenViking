# 安装 lark-daemon

这份文档只讲把 daemon 跑起来。想先了解它解决什么问题，读 [README](./README.md)。

## 准备

- Node.js 22.5 或以上；项目没有 npm 依赖，不需要 `npm install`。
- 已配置 bot profile 的 `lark-cli`。
- 一个 coding agent：默认支持 Codex，也可以使用 Claude、Pi 或火山方舟 Managed Agent。
- 正式常驻运行需要 `pm2`：`npm i -g pm2`。
- OpenViking，用来保存跨会话上下文。每个 agent 在 deployment manifest 中配置自己的 `ovConfig`。

Codex、Claude、Pi 都要先完成各自 CLI 登录。方舟需要 `ARK_API_KEY` 和已绑定 Agent、Environment 的 seed session；完整字段看 [deployment.example.json](./deployment.example.json)。

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
