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

`lark-cli` 收到飞书消息，daemon 把它交给当前 agent runtime；Agent 通过受约束的飞书工具回消息、读文档、查聊天或执行授权动作。Codex、Claude、Pi 和方舟使用不同 transport，但出站都走同一套权限、时效和幂等校验。Activity 页面记录消息、决策和投递结果，方便排查。

## 安装

看 [install.md](./install.md)。里面有依赖、飞书权限、`deployment.json`、首次部署、多 agent 和日常升级。

## 交互规则

- 所有聊天统一具有工作区写权限，可让 Codex 在配置的工作区里完成任务；因此只应把 Agent 加入你信任的聊天。
- 所有聊天共享一个全局 runtime/session，不同 chat 的消息会交错进入同一上下文，用每行的 `chat=` 标签区分归属。
- 群聊的 400ms 从首条待处理消息开始计算，后续补充不会重置时间。不同 chat/thread 各自排队，先到期的先开 turn。Codex/Claude/Pi 已有 turn 时使用即时 steer；Ark 的后续消息进入下一 turn。
- 明确问题、任务、纠正和有效续聊通常会回复；“收到”“谢谢”、闲聊、状态播报、人与人之间的对话、已经有人答好的问题通常保持静默。
- 图片、文件和音视频会以受限资源引用进入 Agent；Codex/Claude/Pi 可按消息中的 image_key 用专用工具查看图片，内容本身不会直接塞进 prompt。Ark 的字符串工具桥目前不传 MCP image content，因此不会向它暴露看图工具。未知消息类型不会触发回复。
- 本机 slash 命令在私聊里直接发 `/` 开头的消息，由 daemon 优先处理并回复，不等待当前模型 turn：`/new`、`/help`、`/status`、`/model [名称]`、`/effort [档位]`。`/new` 开启干净会话；对 Ark 会先成功创建远端 session，再提交本地 epoch。prompt 和代码更新通过当前实例自己的 `lark-daemon upgrade <instance-id>` 发布。`/status` 只看主模型是否正在采样及持续时间；主模型等工具或 subagent 时显示空闲。会话变更类命令会先中断旧 turn。用 `/model pi` 切到 Pi（`/model pi:provider/id` 指定模型），用 `/model ark` 切到火山方舟，用 `/model sonnet`、`opus`、`haiku` 或 `fable` 切到 Claude；其他名称按 Codex 模型处理，例如 `/model gpt-5.6-sol`。跨 runtime 是全局 hard switch：旧 native session 退役，目标 runtime 在第一条真实消息里接上 OV archive overview + live messages。Ark 的 model/effort 由远端 Agent 配置管理。
- 连续 10 分钟没有成功 outbound delivery 后，daemon 只在后续入站消息的可信 metadata 里加 `idle=<seconds>s`，不会预先 reaction。Agent 仍先按正常规则判断是否要处理；Codex/Claude/Pi 只有决定处理且预计是长工作时，才调用 `react_to_lark_message` 的 `temporary: true` 发一个 `OnIt`。Ark 的进程内桥不暴露临时 reaction，只支持最终 reaction。无需回复的群消息和短任务不会产生额外噪音；仅查看后保持静默也不会消费 idle 窗口。MCP sidecar 按 chat/thread 在内存保存 exact `reaction_id`，同 scope 下一次成功的最终文字或 reaction 发出后立即删除，不轮询、不扫 DB。删除失败或进程被 `SIGKILL` 时可能残留，这是 best-effort UX 的明确边界。可用 `LARK_DAEMON_IDLE_REACTION_AFTER_MS=0` 关闭 hint。
- 某一轮模型调用失败时，daemon 会程序化地引用回复一条失败提示（含真实报错），消息不会无声消失。

Codex/Claude 通过 MCP 调用受保护的 Lark 工具，Ark 在 `agent.message` 中返回严格 JSON 决策，再由 daemon 进程内执行。Pi 没有 MCP client 配置接口，直接使用其内置 bash 调用 daemon 固定的本地 `lark-cli`：prompt 限定为 bot identity、完整可信 ID、一次决策一条最终消息和稳定的 idempotency key，且禁止 auth/config/profile 操作。Pi 不获得 daemon 的 runtime token，也不加载 extension；因此 Pi 的 CLI 出站不经过 MCP 的 freshness fence，适合单用户本机运行，不应把它用于需要 host 级别强制审计的部署。其余 runtime 的 `react_to_lark_message`、`reply_lark_message`、`send_lark_message`、`retract_lark_message` 仍保留 freshness fence 和 SQLite sidecar。Codex 默认不通过 shell 调用 `lark-cli`；仅当用户明确要求、且对应可信工具尚未加载时，才按 system prompt 的 fallback 规则执行等价的单条命令（auth/config/admin 操作始终禁止）。

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

daemon 和 slash commands 只通过 `AgentRuntime` 的 `start`、`submit`、`snapshot`、`transition`、`stop` 接口控制模型。`runtime-catalog` 统一 model alias、effort 与 capability；`runtime-adapter` 把 Codex、Claude、Ark 的 transport lifecycle 归一；`runtime-input` 生成认证过的输入 envelope；`runtime-output` 为云端 runtime 执行本地工具，并在副作用前做 authority/freshness/journal 校验。具体 Adapter 只保留协议差异：Codex JSON-RPC、Claude stream-json、Ark Sessions/SSE。`submit` 返回 `accepted: false` 时 caller 仍持有整批消息；返回 `accepted: true` 后 ownership 才交给 runtime。

### MCP 与 CLI 的取舍

当前继续使用 MCP，不另外分发 Agent 专用 CLI。这层 MCP 已经承担了 CLI wrapper 的工作：它收窄工具面、校验参数，并统一进入 `LarkToolService` 的 authority、freshness 和幂等链路。Codex/Claude 可以直接挂 stdio MCP；Ark 暂时由 daemon 通过 JSON bridge 调用同一 MCP handler。这样少一个需要打包、分发和升级的 CLI，现阶段更简单。

等 Managed Agent 支持客户自有 Environment 后，可以重新评估 Ark 的工具入口：把同一组窄工具包装成 CLI，分发到客户 Environment 内，由 Ark 直接调用。这只是替换模型侧的调用协议；CLI 仍应复用现有工具语义，不应绕过 authority/freshness/journal 校验。Codex/Claude 的 stdio MCP 可以独立保留。

## 可靠性边界

- 消息先写 SQLite（状态直接 DONE），再喂给当前常驻 runtime。Codex 用 `turn/start` / `turn/steer`，Claude 用 persistent stream-json input，火山方舟用 session events + SSE，并在断线后以 event history + event id 去重补洞。Ark 会持久化本轮 `user.message` fence；daemon 重启后从远端历史恢复已接受的 turn，不会重复 POST。若 POST 是否被接受无法证明，旧 session 会被持久化隔离，克隆新 session 并原子轮换 epoch/authority 后才恢复队列，避免迟到输出串到下一条消息。
- 400ms 群聊窗口只做 transport batching，不创建 chat 专属的 Codex session、history 或 memory。进程在窗口内停止或崩溃，仍可能让已落库消息没来得及喂给 Codex；这版没有加入 durable replay 或 delivery ledger。
- slash command 和后续消息经过同一条全局 ingress barrier，但命令本身不等待模型；只读命令并行回答，会话变更命令先中断旧 turn。三个 runtime 都先 prepare 新 session，再用一次 SQLite CAS 原子提交 epoch、session、authority 与 model/effort 设置，最后做不可失败的本地 activation；prepare 或 CAS 失败时旧认知状态不变。跨 runtime switch 同样先 preflight 目标进程再交接，目标启动失败时仍留在旧 runtime。
- SQLite 保留 active runtime/session、投递幂等账本和 OV 同步 outbox。跨 runtime 的历史上下文只从 OV session 组装（archive overview + live messages）；同一 native session 继续使用原生 compaction。OV 不可用或上下文不完整时 handoff fail closed，不回放本地 journal。详见 [OV session context](docs/ov-session-context.md)。
- 收到的每条消息压缩成一行 `[chat=… msg=… time=… from=…] 正文`；`chat=`/`msg=` 为完整 id（作为工具参数使用），thread 后缀与 `from=` 为短 stub。新线程首轮注入跨聊天历史，以 `--- history above, new messages below ---` 分隔。
- Codex/Claude 通过 MCP 工具执行飞书动作；云端 Ark 无法访问本机 stdio MCP，所以 daemon 把允许的工具 schema 与严格 `lark-daemon-tools/v1` JSON 协议注入 system policy。Ark 返回 `tool_call` 或 `finish:silent` 决策，daemon 校验完整 JSON/schema、在进程内调用同一个 MCP handler，并把只读结果作为下一 remote subturn 的受限 `tool_result` 送回；成功的 send/reply/reaction/retract 直接结束逻辑 turn，不再自动发送 `agent.message` 文本。工具结果和调用计数会随 managed-turn fence 持久化，重启可继续已生成的结果而不重跑只读工具；无法证明 POST acceptance 时仍隔离旧 session。两条路径都在副作用前校验 active-runtime token/session/epoch 和 freshness，并先写 PENDING journal；成功后 COMMITTED，timeout/crash 保留为 UNCERTAIN。副作用重放遇到 COMMITTED/UNCERTAIN 会 fail closed，不重复发送。Ark 不会把不同 chat/thread 合进同一个远端逻辑 turn，避免工具结果或投递跨会话泄漏。runtime token 是本机单用户进程内的 fencing nonce，不是远程凭证；能读取 daemon SQLite 或进程配置的本机用户，本来就已处于 daemon 的信任边界内。
- Ark 的多工具循环是 daemon 拼出的逻辑 turn，不是一次 Ark 原生 turn。每个 `agent.message` 只能放一个 plain-text JSON `tool_call`；等远端 `end_turn` 后 daemon 才执行工具，再把只读 `tool_result` POST 回去，开启下一个 remote subturn。同一逻辑 turn 最多可串行 8 次工具调用，但一次远端 response 里不能批量或并行发出多个原生 tool call。
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
