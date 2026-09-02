# lark-daemon

把你本机上的 coding agent 接进飞书。它不只是聊天 bot：你可以直接在私聊或群里交代任务，它会在自己的工作区里查资料、改代码、跑命令、调用飞书工具，再把结果送回来。

适合想把 Codex、Claude、Pi 或方舟 Agent 变成长期协作者的人。上下文沉淀在 OpenViking，不用每次重新解释项目背景；代码、凭据和本地工具依然留在自己的机器上。

## 怎么用

1. 在 Mac 或 Devbox 上常驻运行 daemon，把 bot 加进你信任的私聊和群。
2. 直接发任务，不需要每条消息都 `@`。比如“查一下这个报错”“把 README 改短一点并提 PR”“整理今天的讨论”。
3. 需要展开讨论就开 thread。它能执行 coding task、调用 subagent，也能在必要时去其他已授权聊天继续工作。

它默认不抢话：明确问题、任务、纠正才回复；“收到”“谢谢”、闲聊和人与人之间的对话通常保持静默。所有聊天共享一份工作上下文，所以它能接住跨群、跨天的续聊。

## 为什么用它

- **飞书是入口，agent 还是 coding agent。**不用再把需求复制到另一个终端窗口；需要代码、调研、文档或协作动作时，直接在对话里交代。
- **上下文不靠聊天记录硬塞。**项目知识、长期记忆和任务资料放在 OpenViking；每个 agent 有自己的 workspace 和记忆配置。
- **本机可控。**daemon 只是把可信聊天消息和本地 agent 接起来，不把本机工作区搬到云端。
- **可以有多个 agent。**每个 agent 使用独立的飞书 profile、workspace、数据目录和 OpenViking 配置；共享同一个 Web 和 updater。

## 架构，够用就行

`lark-cli` 收到飞书消息，daemon 把它交给当前 agent runtime。Codex、Claude 通过受约束的 MCP 工具执行飞书动作；Pi 与方舟 Self-hosted Managed Agent 通过各自 runtime 的 bash 调用固定的本机 `lark-cli`。方舟由 daemon 负责 Sessions API/SSE，官方 Environment Worker 是唯一工具执行面。Activity 页面记录消息、决策和投递结果，方便排查。

## 安装

看 [install.md](./install.md)。里面有依赖、飞书权限、`deployment.json`、首次部署、多 agent 和日常升级。

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

## 交互规则

- 所有聊天统一具有工作区写权限，可让 Codex 在配置的工作区里完成任务；因此只应把 Agent 加入你信任的聊天。
- 所有聊天共享一个全局 runtime/session，不同 chat 的消息会交错进入同一上下文，用每行的 `chat=` 标签区分归属。
- 群聊的 400ms 从首条待处理消息开始计算，后续补充不会重置时间。不同 chat/thread 各自排队，先到期的先开 turn。Codex/Claude/Pi 已有 turn 时使用即时 steer；Ark 的后续消息进入下一 turn。
- 明确问题、任务、纠正和有效续聊通常会回复；“收到”“谢谢”、闲聊、状态播报、人与人之间的对话、已经有人答好的问题通常保持静默。
- 图片、文件和音视频会以受限资源引用进入 Agent；Codex/Claude/Pi 可按消息中的 image_key 用专用工具查看图片，内容本身不会直接塞进 prompt。Self-hosted Ark 不继承 daemon 的 MCP 图片工具，只有 Worker 环境另行提供等价本地能力时才能读取。未知消息类型不会触发回复。
- 本机 slash 命令在私聊里直接发 `/` 开头的消息，由 daemon 优先处理并回复，不等待当前模型 turn：`/new`、`/help`、`/status`、`/model [名称]`、`/effort [档位]`。`/new` 开启干净会话；对 Ark 会先成功创建远端 session，再提交本地 epoch。prompt 和代码更新通过当前实例自己的 `lark-daemon upgrade <instance-id>` 发布。`/status` 只看主模型是否正在采样及持续时间；主模型等工具或 subagent 时显示空闲。会话变更类命令会先中断旧 turn。用 `/model pi` 切到 Pi（`/model pi:provider/id` 指定模型），用 `/model ark` 切到火山方舟，用 `/model sonnet`、`opus`、`haiku` 或 `fable` 切到 Claude；其他名称按 Codex 模型处理，例如 `/model gpt-5.6-sol`。跨 runtime 是全局 hard switch：旧 native session 退役，目标 runtime 在第一条真实消息里接上 daemon journal。Ark 的 model/effort 由远端 Agent 配置管理。
- 连续 10 分钟没有成功 outbound delivery 后，daemon 只在后续入站消息的可信 metadata 里加 `idle=<seconds>s`，不会预先 reaction。Agent 仍先按正常规则判断是否要处理；Codex/Claude/Pi 只有决定处理且预计是长工作时，才调用 `react_to_lark_message` 的 `temporary: true` 发一个 `OnIt`。Ark 的 Worker/CLI 路径不使用 daemon 的临时 reaction helper，只支持最终 reaction。无需回复的群消息和短任务不会产生额外噪音；仅查看后保持静默也不会消费 idle 窗口。MCP sidecar 按 chat/thread 在内存保存 exact `reaction_id`，同 scope 下一次成功的最终文字或 reaction 发出后立即删除，不轮询、不扫 DB。删除失败或进程被 `SIGKILL` 时可能残留，这是 best-effort UX 的明确边界。可用 `LARK_DAEMON_IDLE_REACTION_AFTER_MS=0` 关闭 hint。
- 某一轮模型调用失败时，daemon 会程序化地引用回复一条失败提示（含真实报错），消息不会无声消失。

Codex/Claude 通过 MCP 调用受保护的 Lark 工具。Pi 与 Self-hosted Ark 没有本机 MCP client 配置面，改由各自 runtime 的 bash 调用 daemon 固定的本地 `lark-cli`；Ark 的调用由官方 Environment Worker 执行，回复可以完全由工具完成，`end_turn` 不要求再返回 `agent.message`。直接 CLI 出站不经过 MCP 的 freshness fence，适合单用户本机运行，不应把它用于需要 host 级别强制审计的部署。Codex/Claude 的 `react_to_lark_message`、`reply_lark_message`、`send_lark_message`、`retract_lark_message` 仍保留 freshness fence 和 SQLite sidecar。Codex 默认不通过 shell 调用 `lark-cli`；仅当用户明确要求、且对应可信工具尚未加载时，才按 system prompt 的 fallback 规则执行等价的单条命令（auth/config/admin 操作始终禁止）。

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

本机 `lark-cli` 的目标 profile 必须已配置且 bot identity 为 `ready`；只有使用 user scope 时才需要额外 OAuth 登录。`codex` 需要已经登录。daemon 会固定启动时选中的 lark profile，不会跟随后续默认 profile 的变化。

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

每个 Agent 是独立 daemon 进程，不是另一个 Agent 的子 agent；manifest 可以增加多个 daemon，它们共享一份 release、Web 和 updater。唯一配置源是 JSON manifest，完整格式见 [`deployment.example.json`](./deployment.example.json)。顶层只接受 `version`、`defaultInstance`、`env`、`agents`；每个 agent 必须完整提供 `id`、`displayName`、`profile`、`port`、`dataDir`、`workspace`、`ovConfig`、`model`。

`env` 是所有 daemon 共用的运行参数，只接受示例中列出的 key，所有 JSON value 都必须是字符串（包括布尔值和数字；空字符串允许）。同名系统进程环境变量优先于 manifest `env`，可用于临时覆盖。Agent identity、Lark profile、端口、dataDir、workspace、OV config、model，以及 Web/updater 控制面字段不能放进 `env`；未知或保留字段会让 preflight 直接失败。每个 agent 的 `profile` 会同时固定注入 `LARK_DAEMON_PROFILE` 和 `LARKSUITE_CLI_PROFILE`，不能被 `env` 覆盖，确保多 Agent 隔离不会被全局配置穿透。

启动 preflight 严格拒绝未知字段、相对路径、非法 id/端口，以及重复的 id、profile、port、dataDir、workspace、OV config；任意 agent 的 dataDir/workspace 互相嵌套也会拒绝。ecosystem 据此生成全部 `lark-daemon-<id>`、Web routes 和 updater allowlist，每个 daemon 都被固定注入自己的 Lark profile、CLI profile、数据、工作区、OV 和 model。

`npm run start:daemon` 默认运行 `defaultInstance`；临时前台跑另一只可设置 `LARK_DAEMON_INSTANCE_ID=<id>`。添加、删除 agent，或修改 id/port 等 topology/allowlist 时，先保存 manifest，再执行 `deploy.sh HEAD`、`bootstrap-updater.sh` 和 `lark-daemon upgrade all`。`upgrade all` 在新拓扑全部验活后，会删除同一受管 release 中已不在 manifest 的旧 daemon PM2 app，不删除数据目录，也不触碰外部同名前缀进程。若重命名 id 时还要立即复用旧端口，先核对旧 app 的 executable 确属本部署，再精确 stop/delete 旧 app；代码不提供 alias 或 migration。普通 daemon 代码升级仍用 `lark-daemon upgrade <id>`。

首次安装，或 release 修改了 updater 自身协议时，运行一次 `deploy.sh` + `bootstrap-updater.sh`。普通代码升级只需先把 commit push 到 upstream `main`，再调用 `lark-daemon upgrade <instance-id>`。升级承载当前 turn 的自身进程也由 updater 继续完成，但当前 CLI/模型连接可能随进程退出，结果应用 `/status` 或本机 health check 验收。

## Activity 页面

打开 [http://127.0.0.1:3737/](http://127.0.0.1:3737/) 可以查看本机活动账本：消息是否收到、Agent 为什么回复或保持静默、选择了哪种投递方式，以及发送是否成功。

- 默认进入当前认知会话（`/new`、同 runtime 的 `/model`、`/effort` 会开新会话）。顶栏可切换历史会话，或查看全部会话的完整账本。
- 下方是按轨道排列的时间轴（回合 / 消息 / 助手 / 投递 / 命令 / 系统）；上方详情列表与播放头双向同步。
- 失败保留在原时间位置并标红；没有“需要处理”队列。
- 历史会话不跟随实时更新，可一键回到当前会话；当前会话在拖离尾部后可回到最新。
- 页面每 4 秒在本机刷新一次；没有外部资源或云端服务。

这些活动作为保留历史的事件账本写入同一个 SQLite。升级时会为已有历史做一次幂等 backfill；普通状态清理不会删除 activity。监听启动记录在新进程接管或正常停止时会收口，因此历史启动仍可见，但只有当前监听显示“进行中”。网页 API 只返回脱敏后的来源/会话引用、认知 epoch 和裁剪后的正文，不暴露飞书 message/chat ID、Codex/Claude/Ark session、幂等键或 raw event。

## Runtime 模块边界

daemon 和 slash commands 只通过 `AgentRuntime` 的 `start`、`submit`、`snapshot`、`transition`、`stop` 接口控制模型。`runtime-catalog` 统一 model alias、effort 与 capability；`runtime-adapter` 把 Codex、Claude、Ark 的 transport lifecycle 归一；`runtime-input` 生成认证过的输入 envelope。具体 Adapter 只保留协议差异：Codex JSON-RPC、Claude stream-json、Ark Sessions/SSE。Self-hosted Ark 的输出和工具执行归 Worker/runtime 所有。`submit` 返回 `accepted: false` 时 caller 仍持有整批消息；返回 `accepted: true` 后 ownership 才交给 runtime。

### MCP 与 CLI 的取舍

Codex/Claude 继续挂本机 stdio MCP。Pi 与 Self-hosted Ark 使用各自已有的 bash 工具调用固定 `lark-cli`，因为这两种 runtime 没有本机 MCP client 配置面。Ark 的调用发生在官方 Environment Worker 进程里；Worker 是唯一工具执行面，也只有这条路径能在同一个原生 turn 中多次调用 Environment 内的 CLI。daemon 只观察远端 `agent.tool_use`、`user.tool_result` 与最终状态。云沙箱的严格 JSON Tool Call bridge 已移除；理论上可把 CLI credential 同步到云沙箱重建类似链路，但这不是当前支持或建议的接入方式。直接 CLI 路径使用稳定幂等键，但不经过 daemon 的 authority/freshness journal，因此其可靠性边界与 MCP 路径不同。

## 可靠性边界

- 消息先写 SQLite（状态直接 DONE），再喂给当前常驻 runtime。Codex 用 `turn/start` / `turn/steer`，Claude 用 persistent stream-json input，火山方舟用 session events + SSE，并在断线后以 event history + event id 去重补洞。Ark 会持久化本轮 `user.message` fence；daemon 重启后从远端历史恢复已接受的 turn，不会重复 POST。若 POST 是否被接受无法证明，旧 session 会被持久化隔离，克隆新 session 并原子轮换 epoch/authority 后才恢复队列，避免迟到输出串到下一条消息。
- 400ms 群聊窗口只做 transport batching，不创建 chat 专属的 Codex session、history 或 memory。进程在窗口内停止或崩溃，仍可能让已落库消息没来得及喂给 Codex；这版没有加入 durable replay 或 delivery ledger。
- slash command 和后续消息经过同一条全局 ingress barrier，但命令本身不等待模型；只读命令并行回答，会话变更命令先中断旧 turn。三个 runtime 都先 prepare 新 session，再用一次 SQLite CAS 原子提交 epoch、session、authority 与 model/effort 设置，最后做不可失败的本地 activation；prepare 或 CAS 失败时旧认知状态不变。跨 runtime switch 同样先 preflight 目标进程再交接，目标启动失败时仍留在旧 runtime。
- SQLite 只保留一个 active runtime/session。跨 runtime journal 记录 accepted inbound、Lark outbound/control 与 uncertain side effect；它不保存隐藏思考。journal 超过上限时 switch fail closed，先 `/new` 再切。
- 收到的每条消息压缩成一行 `[chat=… msg=… time=… from=…] 正文`；`chat=`/`msg=` 为完整 id（作为工具参数使用），thread 后缀与 `from=` 为短 stub。新线程首轮注入跨聊天历史，以 `--- history above, new messages below ---` 分隔。
- Codex/Claude 通过 MCP 工具执行飞书动作。Self-hosted Ark 的原生工具循环由官方 Worker 执行：`agent.tool_use` 后 Session 会以 `requires_action` 暂停，Worker 回写关联的 `user.tool_result` 后继续，最终 `end_turn` 才结束本轮。daemon 不执行工具、不 POST tool result、不转发最终 `agent.message`，避免双重执行和重复投递。
- Ark 不会把不同 chat/thread 合进同一个远端逻辑 turn。daemon 仍以 accepted `user.message` event id 做因果 fence，并持久化 turn/session 恢复信息；但 Worker 直接调用 CLI 的本地副作用不在 daemon SQLite journal 内。Worker/CLI timeout 或 crash 的重复执行保证由 Ark Worker 协议和 CLI 幂等键承担。
- raw 飞书事件不会整包落库，避免保存事件 header 中的 token；正文只为会话上下文保留。
- Activity 账本保留脱敏后的短摘要（含收消息、turn 开始/结束、steer、agent 输出）；老记录由网页折叠，不因业务表的清理而消失。
- 单个 turn 没有总时长 watchdog；Codex/Claude 若长时间不结束一轮，该轮会一直 active。Ark 的 SSE 单次空闲超时默认 15 分钟，随后自动重连并从历史补偿。

当前固定为 raw 事件、text 回复；不支持 compact 订阅。富文本 post 中的图片会作为 image_key 资源引用解析，不解析 markdown 图片语法。

## 飞书端验收

1. 私聊发一个明确任务，应执行并回复。
2. 私聊只发“收到，谢谢”，应保持静默。
3. 群里不 `@` 发一个尚未解决的问题；Agent 有增量价值时回复。
4. 群里发闲聊或人与人的对话，应保持静默。
5. Codex 空闲时，在同一群聊或话题里快速连发一条任务和一条纠正（间隔小于 400ms）；两条应进入同一个 `turn/start`，最终回复采用纠正后的要求。
6. Codex/Claude 思考时立即补一句纠正；该补充会 steer 进同一轮。Ark 下同样操作时，旧草稿会被 freshness fence 抑制，补充消息在下一轮得到回复。
7. 私聊要求 Agent 向另一个已加入群发送测试消息；Agent 应先解析群名，再通过专用工具发送，并在当前私聊确认结果。
