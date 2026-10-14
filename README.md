# Personal Agent daemon

把你本机上的 coding agent 接进飞书和微信。Core 维护一个共享的 Pi session 和 OpenViking 空间；每个消息源由独立 Connector 子进程接入。

适合想把 Codex、TraeX、Claude、Pi 或方舟 Agent 变成长期协作者的人。上下文沉淀在 OpenViking，不用每次重新解释项目背景；代码、凭据和本地工具依然留在自己的机器上。

## 怎么用

1. 在 Mac 或 Devbox 上常驻运行 daemon，把 bot 加进你信任的私聊和群。
2. 直接发任务，不需要每条消息都 `@`。比如“查一下这个报错”“把 README 改短一点并提 PR”“整理今天的讨论”。
3. 需要展开讨论就开 thread。它能执行 coding task、调用 subagent，也能在必要时去其他已授权聊天继续工作。

它默认不抢话：明确问题、任务、纠正才回复；“收到”“谢谢”、闲聊和人与人之间的对话通常保持静默。所有聊天共享一份工作上下文，所以它能接住跨群、跨天的续聊。

## 为什么用它

- **消息源是入口，agent 还是 coding agent。**不用再把需求复制到另一个终端窗口；需要代码、调研、文档或协作动作时，直接在对话里交代。
- **上下文不靠聊天记录硬塞。**项目知识、长期记忆和任务资料放在 OpenViking；每个 agent 有自己的 workspace 和记忆配置。
- **本机可控。**daemon 只是把可信聊天消息和本地 agent 接起来，不把本机工作区搬到云端。
- **可以有多个 agent。**每个 agent 使用独立的飞书 profile、workspace、数据目录和 OpenViking 配置；共享同一个 Web 和 updater。

## 架构，够用就行

Core 根据 manifest 启动 Connector 子进程。飞书 Connector 通过 `lark-cli` 长连接收消息；微信 Connector 通过腾讯 `openclaw-weixin` 的 iLink HTTP 协议长轮询。两者输出统一的 `EVENT` 信封，并进入同一个 `AgentRuntime`。每个 Connector 单独失败、单独重连：微信登录过期这类问题只让微信停下，飞书和 runtime 照常运行。出站方向，所有 runtime 都调用同一套 Agent 工具（`send_message`、`reply_message` 等）：Codex/TraeX/Claude 经 MCP 适配器，Pi 经 CLI，两者都只是把调用转发给 Core 的本机 socket。Core 统一校验运行权、新鲜度、路由与内容，写入唯一的 `outbox` 表后再由对应 Connector 执行；daemon 自己的失败通知和 slash 命令回复走同一条路径。协议和生命周期见 [Connector protocol 0.2](docs/connector-protocol.md)。

Core 的入站模型同时支持聊天与非聊天事件：所有来源写入 `connector_events`，按来源实例和事件 ID 去重；聊天、消息和回复路由字段可选。GitHub issue、Calendar 提醒等可以使用 `kind`、`subject`、标题与正文进入 runtime，无须包装成飞书消息。内置 Connector 为飞书、微信和邮箱（IMAP/SMTP）；新增来源需实现 Connector。非聊天事件只能经 `notify_owner` 通知 owner（你本人）：Agent 不选目的地，Core 发到主 IM（`channel`）上你的私聊。owner 身份由 Connector 自检时给出：飞书是该 profile 用 lark-cli 做 user 登录的账号，微信是扫码登录的账号。协议已更新为 0.2，本次为未上线产品的直接 schema 变更，使用新的数据目录，不迁移旧 `inbound` 表。

## 安装

看 [install.md](./install.md)。里面有依赖、飞书权限、`deployment.json`、首次部署、多 agent 和日常升级。

### 微信单聊 MVP

可以在 `deployment.json` 中增加一个微信实例。`channel` 是兼容字段；`connectors` 声明该 Core 启动的 Connector。`profile` 目前仍是必填字段，但纯微信实例不会用它访问飞书：

```json
{
  "id": "weixin",
  "displayName": "Weixin Pi",
  "channel": "weixin",
  "connectors": ["weixin"],
  "profile": "weixin_unused",
  "port": 3741,
  "dataDir": "/Users/you/.local/share/lark-daemon-weixin",
  "workspace": "/Users/you/Documents/work/weixin-workspace",
  "ovConfig": "/Users/you/.openviking/ovcli.conf.weixin",
  "model": "pi"
}
```

微信实例可以使用 Codex、TraeX、Claude 或 Pi runtime（示例用 Pi）；方舟 Self-hosted Ark 的工具执行面在 Worker 里，访问不到 Core 的 Agent 工具，因此不支持微信。要让同一个 session 和 OV 空间同时接收飞书与微信，在现有实例上配置：

```json
{
  "channel": "lark",
  "connectors": ["lark", "weixin"],
  "model": "pi"
}
```

随后对这个实例执行一次 `npm run weixin:login -- <instance-id>`。不配置 `connectors` 时仍按旧的 `channel` 启动单个 Connector。

安装依赖后扫码，再以前台方式启动这个实例：

```bash
npm install
npm run weixin:login -- weixin
LARK_DAEMON_INSTANCE_ID=weixin npm run start:daemon
```

终端会显示二维码和备用链接。用微信扫码并在手机确认后，凭证写入该实例的 `dataDir/weixin/state.sqlite3`；随后可以给新出现的机器人联系人发送文本、图片或文件。带有微信语音转写的消息会以转写文本进入 Agent。默认只接受完成扫码的微信用户，避免其他联系人触发本机 Agent。需要显式增加发送者时，可在 manifest 的共享 `env` 中设置 `LARK_DAEMON_WEIXIN_ALLOW_FROM`，值为逗号分隔的完整微信 iLink 用户 ID。

这个 MVP 使用一个微信账号，支持单聊文本、入站图片和文件、微信提供的语音转写，以及出站图片和文件。入站媒体经腾讯 CDN 下载和 AES 解密后保存在该实例的 `dataDir/weixin/media`，单个文件和出站 workspace 文件上限均为 20 MiB，并随 daemon 的保留周期清理。原始语音解码/ASR、视频、群聊、引用和 reaction 尚未接入。协议实现固定对齐 `Tencent/openclaw-weixin` 2.4.9，来源与许可证见 [微信协议说明](packages/daemon/src/weixin/NOTICE.md) 和 [MIT 许可证](packages/daemon/src/weixin/LICENSE.openclaw-weixin)。

### 邮箱

邮箱 Connector 用 IMAP 只读监听一个邮箱的收件箱（不会把邮件标成已读，也不移动、不删除），用 SMTP 回信。新邮件到达后，Agent 判断要不要告诉你，要的话发到你在主 IM 上的私聊。Agent 从不直接发邮件：无论是你让它回，还是它觉得该回，它都只能起草，Core 把草稿放在一张卡片上发给你（收件人、主题和可编辑的正文），你点"发送"才会以卡片上的内容发出，点"不发了"就作废。卡片只有你能操作，三天后过期，目前需要主 IM 是飞书。首次启动只从之后到达的邮件开始；订阅和群发邮件标为 `kind=email.list`，自动回复（含多数退信）和它自己的回信直接跳过；程序自动发出的通知（安全告警、任务失败等）照常交给 Agent 判断。

在实例上加 `email` 并指向账号文件（文件权限必须是 0600，不要写进 `env`）：

```json
{
  "id": "primary",
  "channel": "lark",
  "connectors": ["lark", "email"],
  "emailConfig": "/Users/you/.lark-daemon/email-primary.json"
}
```

```json
{
  "address": "you@gmail.com",
  "password": "<客户端专用密码>",
  "imap": { "host": "imap.gmail.com", "port": 993 },
  "smtp": { "host": "smtp.gmail.com", "port": 465 }
}
```

`password` 是邮箱给第三方客户端用的专用密码，按邮箱账号生成一次，IMAP 和 SMTP 共用：Gmail 叫应用密码（需先开两步验证，填写时去掉空格），QQ/163 叫授权码（需先在设置里开启 IMAP/SMTP）。SMTP 在 465 端口用直连 TLS，其他端口用 STARTTLS，可用 `smtp.secure` 覆盖；可选 `username`（默认同 `address`）和 `name`（回信的发件人名）。只用 OAuth 的邮箱（如 Outlook）暂不支持。方舟 Self-hosted Ark 用不了 Agent 工具，因此不支持邮箱。

### 方舟 MA 配置

方舟只支持 Self-hosted Managed Agent。最小接入流程：

1. 在方舟控制台创建或选择 `config.type=self_hosted` 的 Environment，把目标 Agent 绑定到该 Environment，并创建一个 seed session。可参考[已验证的 Self-hosted Environment](https://console.volcengine.com/ark/region:cn-beijing/managed-agents/environments/env-20260831031839-rm2nj?searchField=Name)。
2. 在 `deployment.json` 的目标 agent 中同时配置 seed session 和 Environment；二者必须属于同一个 Environment，每个 bot 使用独立配置：

   ```json
   {
     "model": "ark",
     "volcSessionId": "sesn-your-self-hosted-seed",
     "volcEnvironmentId": "env-your-self-hosted-environment"
   }
   ```

3. daemon 进程需要 `ARK_API_KEY`。另外独立常驻官方 Go `EnvironmentWorker`，给 Worker 设置以下进程环境变量；密钥不要写入 `deployment.json`：

   ```bash
   ARK_API_KEY="..."
   ARK_BASE_URL="https://ark.cn-beijing.volces.com/api/v3"
   MA_ENVIRONMENT_ID="env-your-self-hosted-environment"
   LARKSUITE_CLI_PROFILE="cli_primary"
   ```

4. 先确认该 profile 的本机 `lark-cli` 可用，再启动 Worker 和 daemon。daemon 只负责 Sessions API/SSE，Worker 是唯一工具执行面；Worker 的进程部署、存活与升级不由本仓库托管。
5. 用一个原生 turn 触发至少两次本地 CLI 调用做验收。预期可重复经过 `agent.tool_use -> requires_action -> user.tool_result`，最后以 `end_turn` 成功结束；即使没有返回 `agent.message` 也不应报错。

云沙箱和严格 JSON `agent.message` Tool Call bridge 均不再支持。把 CLI credential 同步进云沙箱理论上可能实现，但不是当前建议的接入方式。完整部署说明见 [install.md 的方舟 Self-hosted Managed Agent 小节](./install.md#方舟-self-hosted-managed-agent)。

## 文档附件与交互卡片

`send_message` / `reply_message` 的正文可选择 `markdown`、`file_path`、`file_key`、`card` 或 `choices`，每次只选一种（微信只支持 `markdown` 与 `file_path`）。文件相对于 Agent workspace，最多 20 MiB，图片按图片发送；自定义卡片支持 inline Card 1.0/2.0，最多 30 KiB。话题内的文件和卡片使用 reply + `reply_in_thread: true`。

`choices` 生成带按钮的单选问题，发送立即返回；用户点击后，daemon 校验答题人、有效期与重复提交，将答案作为新输入交给 Agent，并尽力更新原卡片。问题状态与话题路由持久化到 SQLite。普通卡片消息也会进入 Agent，正文缺失时显示 `[card]`。完整参数、限制和调用示例见 [消息格式指南](packages/daemon/agent/lark-message-formats.md)。这些出站参数对所有 runtime 一致；只有经 Agent 工具发出的卡片才有回调登记。

部署前必须在飞书应用的「回调配置」启用 `card.action.trigger` 长连接，详见 [安装说明](install.md#配飞书)。

## 交互规则

- 所有聊天统一具有工作区写权限，可让 Codex 在配置的工作区里完成任务；因此只应把 Agent 加入你信任的聊天。
- 所有聊天共享一个全局 runtime/session，不同 chat 的消息会交错进入同一上下文，用每行的 `chat=` 标签区分归属。
- 群聊的 400ms 从首条待处理消息开始计算，后续补充不会重置时间。不同 chat/thread 各自排队，先到期的先开 turn。Codex/TraeX/Claude/Pi 已有 turn 时使用即时 steer；Ark 的后续消息进入下一 turn。
- 明确问题、任务、纠正和有效续聊通常会回复；“收到”“谢谢”、闲聊、状态播报、人与人之间的对话、已经有人答好的问题通常保持静默。
- 图片、文件和音视频会以受限资源引用进入 Agent；Codex/TraeX/Claude/Pi 可用 `get_message_media` 按消息中的 image_key/file_key（微信按消息 ID）取回本地文件，图片在 MCP 中直接显示，内容本身不会直接塞进 prompt。Self-hosted Ark 不继承 daemon 的 Agent 工具，只有 Worker 环境另行提供等价本地能力时才能读取。未知消息类型不会触发回复。
- 本机 slash 命令在私聊里直接发 `/` 开头的消息，由 daemon 优先处理并回复，不等待当前模型 turn：`/new`、`/help`、`/status`、`/model [名称]`、`/effort [档位]`。`/new` 开启干净会话；对 Ark 会先成功创建远端 session，再提交本地 epoch。prompt 和代码更新通过当前实例自己的 `lark-daemon upgrade <instance-id>` 发布。`/status` 只看主模型是否正在采样及持续时间；主模型等工具或 subagent 时显示空闲。会话变更类命令会先中断旧 turn。用 `/model traex` 切到 TraeX（`/model trae:<model>` 指定 TraeX 模型），用 `/model pi` 切到 Pi（`/model pi:provider/id` 指定模型），用 `/model ark` 切到火山方舟，用 `/model sonnet`、`opus`、`haiku` 或 `fable` 切到 Claude；其他名称按当前动态 runtime 解析，不在动态 runtime 上时按 Codex 模型处理，例如 `/model gpt-5.6-sol`。跨 runtime 是全局 hard switch：旧 native session 退役，目标 runtime 在第一条真实消息里接上 OV archive overview + live messages。Codex/TraeX/Claude/Pi 支持 daemon 侧 `/effort`；Ark 的 model/effort 由远端 Agent 配置管理。
- 连续 10 分钟没有成功 outbound delivery 后，daemon 只在后续入站消息的可信 metadata 里加 `idle=<seconds>s`，不会预先 reaction。Agent 仍先按正常规则判断是否要处理；Codex/TraeX/Claude/Pi 只有决定处理且预计是长工作时，才调用 `react_to_message` 的 `temporary: true` 发一个 `OnIt`。Ark 的 Worker/CLI 路径不使用 daemon 的临时 reaction helper，只支持最终 reaction。无需回复的群消息和短任务不会产生额外噪音；仅查看后保持静默也不会消费 idle 窗口。Core 按 chat/thread 在内存保存 exact `reaction_id`，同 scope 下一次成功的最终文字或 reaction 发出后立即删除，不轮询、不扫 DB。删除失败或进程被 `SIGKILL` 时可能残留，这是 best-effort UX 的明确边界。可用 `LARK_DAEMON_IDLE_REACTION_AFTER_MS=0` 关闭 hint。

- 某一轮模型调用失败时，daemon 会程序化地引用回复一条失败提示（含真实报错），消息不会无声消失。

Codex/TraeX/Claude（MCP）与 Pi（CLI）的发消息、回复、reaction、撤回都经 Core 的 Agent 工具，统一受 runtime authority、freshness fence、幂等 outbox 与投递账本约束；prompt 禁止它们改用 `lark-cli` 发消息。`lark-cli` 仍以固定 bot profile 留给文档、日历等非消息类操作（auth/config/admin 操作始终禁止）。Self-hosted Ark 例外：官方 Environment Worker 无法访问本机 socket，仍由 Worker 的 bash 调用固定的本地 `lark-cli` 回复，不经过 freshness fence 与 outbox；回复可以完全由工具完成，`end_turn` 不要求再返回 `agent.message`。

## 飞书前置条件

仓库根目录的 [`permission.json`](./permission.json) 是完整功能权限清单。首次配置应用时，在飞书开放平台进入「开发配置 → 权限管理 → 批量开通」，导入该文件；具体格式和审核规则见 [官方权限申请说明](https://open.feishu.cn/document/server-docs/application-scope/introduction?lang=zh-CN)。清单覆盖 daemon 可调用的文档、消息、任务、会议等完整能力，并非最小权限集；正式环境应按实际用途删减权限、限制应用可见范围。新增的需审核权限只有在创建应用版本、发布并经管理员审核后才会生效。

只运行基础消息链路至少需要：

1. 使用长连接订阅 `im.message.receive_v1`。
2. 私聊消息权限 `im:message.p2p_msg`（或对应只读权限）。
3. 群聊不 `@` 也要收到消息，需要敏感权限 `im:message.group_msg`；只有 group-at 权限时，平台不会投递普通群消息。
4. 机器人发消息权限 `im:message:send_as_bot`。
5. 获取机器人所在群列表权限 `im:chat:read`。
6. 把机器人加入需要参与的群，并把应用可见范围限制为自己的日常使用范围。

截至 `lark-cli 1.0.86`，CLI 没有导入或发布开放平台应用权限清单的命令：`lark-cli application` 只管理 slash command，`lark-cli apps` 管理的是妙搭应用。不要用 `lark-cli auth login` 处理 bot 缺权；bot scope 必须在开发者后台导入、发布并完成审核。清单中的 user scope 还需要对应用户执行 OAuth 登录授权。

本机 `lark-cli` 的目标 profile 必须已配置且 bot identity 为 `ready`；只有使用 user scope 时才需要额外 OAuth 登录。当前选择的本机 agent CLI（例如 `codex` 或 `traecli`）需要已经登录。daemon 会固定启动时选中的 lark profile，不会跟随后续默认 profile 的变化。

## 本地开发验证

```bash
cd lark-daemon
mkdir -p ~/.lark-daemon
cp deployment.example.json ~/.lark-daemon/deployment.json
npm test
npm run check
npm run start:daemon   # 127.0.0.1:3738
npm run start:web      # 127.0.0.1:3737
```

源码目录应使用独立的小工作区，避免测试中的 Codex 改到 daemon 自身。正式 PM2 release 安装在 `~/.local/lib/lark-daemon/releases/`；每个实例的工作区由 release 之外的持久 manifest 独立配置。

## 日常运维

```bash
pm2 status lark-daemon-<instance-id> lark-web lark-updater
pm2 logs lark-daemon-<instance-id> --lines 100
curl http://127.0.0.1:3737/ready
lark-daemon upgrade <instance-id>
lark-daemon upgrade all
```

`deploy.sh` 是首次安装或 updater 控制面协议变更时的 bootstrap 工具，不是日常升级步骤。

`lark-updater` 监听权限为 `0600` 的本机 Unix socket，不开放 TCP 端口，也不读取 Agent 的源码 checkout。它只接受 manifest 中的 agent id 和 `all`，从固定的 upstream `main` 发布 release；请求不能传 SHA、ref、路径、remote 或 shell。新 commit 会先打成隔离 release，链接共享 env，跑完整测试与 syntax check，全部通过后才原子切换 `current`。随后 updater 从同一份 ecosystem config 滚动目标 daemon；`all` 还会滚动共享 Web。相同 commit 的第二次请求直接复用已验证 release。整个过程持有同一把 deploy lock。

### 可横向扩展的多 Agent 部署

每个 Agent 是独立 daemon 进程，不是另一个 Agent 的子 agent；manifest 可以增加多个 daemon，它们共享一份 release、Web 和 updater。唯一配置源是 JSON manifest，完整格式见 [`deployment.example.json`](./deployment.example.json)。顶层只接受 `version`、`defaultInstance`、`env`、`agents`；每个 agent 必须完整提供 `id`、`displayName`、`profile`、`port`、`dataDir`、`workspace`、`ovConfig`、`model`，可用 `channel` 选择 `lark` 或 `weixin`，省略时默认 `lark`。

`env` 是所有 daemon 共用的运行参数，只接受示例中列出的 key，所有 JSON value 都必须是字符串（包括布尔值和数字；空字符串允许）。同名系统进程环境变量优先于 manifest `env`，可用于临时覆盖。Agent identity、channel、Lark profile、端口、dataDir、workspace、OV config、model，以及 Web/updater 控制面字段不能放进 `env`；未知或保留字段会让 preflight 直接失败。每个 agent 的 `profile` 会同时固定注入 `LARK_DAEMON_PROFILE` 和 `LARKSUITE_CLI_PROFILE`；微信实例的 Agent 子进程不会继承这两个飞书变量。

启动 preflight 严格拒绝未知字段、相对路径、非法 id/端口，以及重复的 id、profile、port、dataDir、workspace、OV config；任意 agent 的 dataDir/workspace 互相嵌套也会拒绝。ecosystem 据此生成全部 `lark-daemon-<id>`、Web routes 和 updater allowlist，每个 daemon 都被固定注入自己的 Lark profile、CLI profile、数据、工作区、OV 和 model。

`npm run start:daemon` 默认运行 `defaultInstance`；临时前台跑另一只可设置 `LARK_DAEMON_INSTANCE_ID=<id>`。添加、删除 agent，或修改 id/port 等 topology/allowlist 时，先保存 manifest，再执行 `deploy.sh HEAD`、`bootstrap-updater.sh` 和 `lark-daemon upgrade all`。`upgrade all` 在新拓扑全部验活后，会删除同一受管 release 中已不在 manifest 的旧 daemon PM2 app，不删除数据目录，也不触碰外部同名前缀进程。若重命名 id 时还要立即复用旧端口，先核对旧 app 的 executable 确属本部署，再精确 stop/delete 旧 app；代码不提供 alias 或 migration。普通 daemon 代码升级仍用 `lark-daemon upgrade <id>`。

首次安装，或 release 修改了 updater 自身协议时，运行一次 `deploy.sh` + `bootstrap-updater.sh`。普通代码升级只需先把 commit push 到 upstream `main`，再调用 `lark-daemon upgrade <instance-id>`。升级承载当前 turn 的自身进程也由 updater 继续完成，但当前 CLI/模型连接可能随进程退出，结果应用 `/status` 或本机 health check 验收。

## Activity 页面

打开 [http://127.0.0.1:3737/](http://127.0.0.1:3737/) 可以查看本机活动账本：消息是否收到、Agent 每一轮做了什么（思考、工具调用）、选择了哪种投递方式，以及发送是否成功。

- 默认进入当前认知会话（`/new`、同 runtime 的 `/model`、Codex/TraeX/Claude/Pi 切换 `/effort` 会开新会话；TraeX `/effort` 原地更新当前 thread settings）。顶栏可切换历史会话，或查看全部会话的完整账本。
- 下方是按轨道排列的时间轴（回合 / 消息 / 助手 / 投递 / 命令 / 系统）；上方详情列表与播放头双向同步。
- 失败保留在原时间位置并标红；没有“需要处理”队列。
- 历史会话不跟随实时更新，可一键回到当前会话；当前会话在拖离尾部后可回到最新。
- 页面每 4 秒在本机刷新一次；没有外部资源或云端服务。

这些活动作为保留历史的事件账本写入同一个 SQLite；普通状态清理不会删除 activity。监听启动记录在新进程接管或正常停止时会收口，因此历史启动仍可见，但只有当前监听显示“进行中”。网页 API 只返回脱敏后的来源/会话引用、认知 epoch 和裁剪后的正文，不暴露飞书 message/chat ID、Codex/TraeX/Claude/Ark session、幂等键或 raw event。

## Runtime 模块边界

daemon 和 slash commands 只通过 `AgentRuntime` 的 `start`、`submit`、`snapshot`、`transition`、`stop` 接口控制模型。`runtime-catalog` 统一 model alias、effort 与 capability；`runtime-adapter` 把 Codex、TraeX、Claude、Pi、Ark 的 transport lifecycle 归一；`runtime-input` 生成认证过的输入 envelope。具体 Adapter 只保留协议差异：Codex JSON-RPC、Claude stream-json、Pi RPC JSONL、Ark Sessions/SSE。Self-hosted Ark 的输出和工具执行归 Worker/runtime 所有。`submit` 返回 `accepted: false` 时 caller 仍持有整批消息；返回 `accepted: true` 后 ownership 才交给 runtime。

### MCP 与 CLI 的取舍

Agent 工具只有一份定义与实现，在 Core 的 `ActionService`。Codex/TraeX/Claude 挂本机 stdio MCP 适配器（`actions/mcp.mjs`），Pi 没有 MCP client 配置面，用 bash 调 `actions/cli.mjs`；两者都只转发到 `<dataDir>/actions.sock`，runtime 子进程经 `PERSONAL_AGENT_SOCKET` / `PERSONAL_AGENT_AUTHORITY` 拿到地址和运行权。Self-hosted Ark 使用 Worker 的 bash 调用固定 `lark-cli`，因为 Worker 不在 daemon 的进程树里。Ark 的调用发生在官方 Environment Worker 进程里；Worker 是唯一工具执行面，也只有这条路径能在同一个原生 turn 中多次调用 Environment 内的 CLI。daemon 只观察远端 `agent.tool_use`、`user.tool_result` 与最终状态。云沙箱的严格 JSON Tool Call bridge 已移除；理论上可把 CLI credential 同步到云沙箱重建类似链路，但这不是当前支持或建议的接入方式。Ark 的直接 CLI 路径使用稳定幂等键，但不经过 daemon 的 authority/freshness 与 outbox，因此其可靠性边界与其他 runtime 不同。

## 可靠性边界

- 消息先写 SQLite（状态直接 DONE），再喂给当前常驻 runtime。Codex/TraeX 用 `turn/start` / `turn/steer`，Claude 用 persistent stream-json input，火山方舟用 session events + SSE，并在断线后以 event history + event id 去重补洞。Ark 会持久化本轮 `user.message` fence；daemon 重启后从远端历史恢复已接受的 turn，不会重复 POST。若 POST 是否被接受无法证明，旧 session 会被持久化隔离，克隆新 session 并原子轮换 epoch/authority 后才恢复队列，避免迟到输出串到下一条消息。
- 400ms 群聊窗口只做 transport batching，不创建 chat 专属的 Codex session、history 或 memory。进程在窗口内停止或崩溃，仍可能让已落库消息没来得及喂给 Codex；这版没有加入 durable replay 或 delivery ledger。
- slash command 和后续消息经过同一条全局 ingress barrier，但命令本身不等待模型；只读命令并行回答，会话变更命令先中断旧 turn。会话变更先 prepare 新 session，再用一次 SQLite CAS 原子提交 epoch、session、authority 与 model/effort 设置（Codex/TraeX/Claude/Pi 的 effort 属于这类会话变更），最后做不可失败的本地 activation；prepare 或 CAS 失败时旧认知状态不变。跨 runtime switch 同样先 preflight 目标进程再交接，目标启动失败时仍留在旧 runtime。
- SQLite 保留 active runtime/session、投递幂等账本和 OV 同步 outbox。跨 runtime 的历史上下文只从 OV session 组装（archive overview + live messages）；同一 native session 继续使用原生 compaction。OV 不可用或上下文不完整时 handoff fail closed，不回放本地 journal。详见 [OV session context](docs/ov-session-context.md)。
- 收到的每条消息压缩成一行 `[chat=… msg=… event=… time=… from=…] 正文`；`chat=`/`msg=`/`event=` 为完整 id（作为工具参数使用），thread 后缀与 `from=` 为短 stub。`msg=` 是回复目标，`event=` 是 `decision_id`；日历、issue 等非聊天事件没有 `msg=`，同样用 `event=` 发通知。新线程首轮注入跨聊天历史，以 `--- history above, new messages below ---` 分隔。
- Codex/TraeX/Claude/Pi 通过 Core 的 Agent 工具执行消息动作。Self-hosted Ark 的原生工具循环由官方 Worker 执行：`agent.tool_use` 后 Session 会以 `requires_action` 暂停，Worker 回写关联的 `user.tool_result` 后继续，最终 `end_turn` 才结束本轮。daemon 不执行工具、不 POST tool result、不转发最终 `agent.message`，避免双重执行和重复投递。
- Ark 不会把不同 chat/thread 合进同一个远端逻辑 turn。daemon 仍以 accepted `user.message` event id 做因果 fence，并持久化 turn/session 恢复信息；但 Worker 直接调用 CLI 的本地副作用不在 daemon SQLite journal 内。Worker/CLI timeout 或 crash 的重复执行保证由 Ark Worker 协议和 CLI 幂等键承担。
- raw 飞书事件不会整包落库，避免保存事件 header 中的 token；正文只为会话上下文保留。
- Activity 账本保留脱敏后的短摘要（含收消息、turn 开始/结束、steer、agent 输出）；老记录由网页折叠，不因业务表的清理而消失。
- 单个 turn 没有总时长 watchdog；Codex/TraeX/Claude 若长时间不结束一轮，该轮会一直 active。Ark 的 SSE 单次空闲超时默认 15 分钟，随后自动重连并从历史补偿。

当前固定为 raw 事件、text 回复；不支持 compact 订阅。富文本 post 中的图片会作为 image_key 资源引用解析，不解析 markdown 图片语法。

## 飞书端验收

1. 私聊发一个明确任务，应执行并回复。
2. 私聊只发“收到，谢谢”，应保持静默。
3. 群里不 `@` 发一个尚未解决的问题；Agent 有增量价值时回复。
4. 群里发闲聊或人与人的对话，应保持静默。
5. Codex/TraeX 空闲时，在同一群聊或话题里快速连发一条任务和一条纠正（间隔小于 400ms）；两条应进入同一个 `turn/start`，最终回复采用纠正后的要求。
6. Codex/TraeX/Claude 思考时立即补一句纠正；该补充会 steer 进同一轮。Ark 下同样操作时，旧草稿会被 freshness fence 抑制，补充消息在下一轮得到回复。
7. 私聊要求 Agent 向另一个已加入群发送测试消息；Agent 应先解析群名，再通过专用工具发送，并在当前私聊确认结果。
