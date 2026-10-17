# CLAUDE.md

单用户、本机常驻的 Personal Agent Core。`packages/daemon` 维护一个全局 AgentRuntime、SQLite、OpenViking session 和内部 API；Lark/微信/邮箱由 `src/connectors/worker.mjs` 子进程接入。`packages/web` 提供本机 Activity 页面与固定路由代理。产品行为和飞书权限见 README.md,此处只写改代码需要的东西。

## 架构(steer 模式)

Core 是一根薄管道,核心数据流:

```
Connector worker (protocol 0.2 NDJSON; Lark 长连接或微信长轮询)
  → EVENT envelope
  → harness.mjs handleConnectorEvent(入站管线:标准事件校验 → 可选扩展处理 →
      deterministicFilter → slash 识别 → ingest 去重落库 → burst/直送)
  → event.mjs normalizeEvent + deterministicFilter(通用 kind/subject/content，聊天与回复字段可选)
  → commands.mjs(`/` 开头 = 本机 slash 命令:/new /help /model /effort,
      前缀匹配,daemon 直接执行并经 ActionService.replyToEvent 回信,不进 runtime 也不进 history)
  → store.mjs ingest(SQLite 按来源实例+事件 ID 去重,connector_events 表分配 seq)
  → AgentRuntime.submit(formatInboundLine 压缩成一行；非聊天保留 kind/event/subject)
      空闲 → turn/start;思考中 → turn/steer;启动中 → queue
  → 常驻 runtime(Codex/TraeX app-server / Claude stream-json / Pi `--mode rpc` / Volc Sessions API)
  → 出站:runtime 调 Agent 工具(Codex/TraeX/Claude/Pi 经 actions/mcp.mjs)
      → <dataDir>/actions.sock → actions/service.mjs ActionService(authority → 路由 →
      freshness → 内容/manifest 校验 → outbox+journal 预留)→ Connector action → 结算
```

Connector 协议见 `docs/connector-protocol.md`。生命周期是 `spec → check → start → action → pause → stop`；stdout 只允许协议 NDJSON，日志写 stderr。新数据源按能力声明 `events/actions/search/sync`，出站动作与只读查询分别写进 manifest 的 `actions`/`queries`(Core 据此决定开放哪些 Agent 工具)。provider receive loop 留在 Connector，出站校验留在 Core。单个 Connector 退出或 check/start 失败只影响它自己:`ConnectorManager` 从 spec 开始按 5s/15s/1min/5min 退避重启，稳定运行 30s 才算恢复并清零退避;其余 Connector 和 runtime 不动，全部起不来才算启动失败。投递到不可用的 Connector 在预留 outbox 之前拦下(`connector_unavailable`);`/ready` 只要有一个 Connector 在跑就是 200,body `status=degraded`。

Lark 原始事件解析在 `connectors/lark-events.mjs`；微信直接输出标准事件。Core 不接受原始 provider envelope。卡片插件只负责标准交互与已发送卡片的可信路由关联；会话键由 `event.mjs` 统一构造。此次未上线 schema 直接替换，无旧 inbound 表兼容视图或迁移。

`daemon.mjs` 只是 composition root + 进程生命周期。各真模块:`harness.mjs`(入站管线 + ingress barrier + group burst)、`actions/`(唯一出站路径:ActionService + socket API + MCP 前端)、`notices.mjs`(FailurePolicy:失败通知静音 / claude→codex 回退)、`chat-names.mjs`(后台群名解析)、`http-api.mjs`(loopback /api/activity + /health)。管线的 e2e 测试面是 `test/mock-env.mjs`(假 lark-cli 动态喂事件 + 假 codex app-server 可脚本化 turn 结果 + 安静 OV,详见 `test/daemon.integration.test.mjs`)。

- **运行时可变 model/effort**:`/model` 写入当前 runtime 的 model setting,优先于 env 配置;`/model`(同 runtime 也一样)开新原生 session,沿用 OV epoch 并以 OV context 接上。Codex/TraeX/Claude/Pi 支持 `/effort` 并写入对应 runtime 的 effort setting,切换后自动开空 thread，避免旧档位的失败状态污染后续轮次。TraeX 不传 `--effort`;新 thread / turn 通过 app-server config 和 `turn/start` effort 生效。`/model` 的可选项来自 app-server `model/list`,参数按列表前缀解析。`/new` 走 `transition({ kind: 'new-session' })` → `rotateSession()`:开新 OV epoch 和空 thread，不带旧 history。

- **Conversation policy**:`conversation-policy.mjs` 装配 `agent/system-prompt.md` + `openviking.md` + 可选 `meeting-audio.md` + `harness.md`。Codex/TraeX/Claude/Pi 吃整份装配结果；Volc 只吃 inbound 文法 + persona，避免在 `volc.mjs` 里复述。已知缺口:Volc 没装配 OV identity / 使用约定。改这些 markdown 会变 `policyHash`，旧 thread 不再 resume。
- **OpenViking**:identity 注入默认关闭，manifest `env` 设 `VIKA_OV_IDENTITY=true` 才开启：daemon 启动时、建 runtime 之前经 OV HTTP(`OVSessionClient.read`)读一次 `viking://user/<id>/identity.md`（404 再试 `memories/identity.md`），存进 `config.openVikingIdentity` 后注入 conversation policy；读失败只记 `ov_identity_unavailable`，不阻断启动。daemon 不调用 `ov` 命令。跨 runtime context 由 `ov-session-context.mjs` 同步并从 OV session assemble；其他记忆读写走 skill / MCP。OV 是可分享的云存储，允许在飞书里披露。`ovConfig` 可选：不配时 daemon 不建 OV session 同步、不提供 `read_openviking_session_context`、prompt 不放 OV 段落，fresh native session 不带历史（`cognitionHistoryPrefix` 见 `store.getOVContext` 不存在即返回空），并给 runtime 传 `OPENVIKING_MEMORY_ENABLED=0`，关掉用户全局装的 OV 记忆插件（托管 Pi 共用 `~/.pi/agent`）。`profile` 只属于飞书 Connector，非飞书实例不能填。
- **Meeting plugin**:`meeting/plugin.mjs` 独立组装。ASR final 经 `insertText` 变成普通文本 item，不在 `PersonalAgentDaemon` 里接线。
- **全局单线程**:所有 Connector/chat 共用一个 runtime session,消息交错进同一上下文,靠行内 `source=` + `chat=` 标签区分。`policyHash`(装配后的 policy + workspace + runtime policy version)变化时不再 resume 旧 thread,新 thread 会丢跨会话上下文。
- **CodexAgent 状态机**(codex.mjs):`activeTurnId` / `startingTurn` / `queue` 三态;turn/start 失败 unshift 回队列,steer 撞上 turn 刚结束会 fallback 到 deliver,断线走 `_reconnectLoop` + `thread/resume`。永不丢消息是硬性不变量,Codex 和 TraeX 复用这套基类，改这里必须跑 codex.test.mjs 和 traex.test.mjs。
- **PiAgent 状态机**(pi.mjs):和 Claude 一样是常驻 stdio 适配器,协议是 `pi --mode rpc` JSONL。空闲 inbound 写 `prompt`,活跃 turn 写 `steer`,会话类命令走 `abort` 后换进程;`set_model` / `set_thinking_level` / `get_available_models` 映射 `/model` `/effort`;`/new` 开空 Pi session。Pi 由 npm 锁定并随 release 安装，默认不使用全局 pi；显式 `PI_BIN` 必须是同一版本，预检会拒绝其他版本。启动时显式加载 pi-mcp-extension.mjs，只在该会话注册 personal_agent MCP（direct exposure），等待全部 Core 工具加载成功、且 Pi 回应首条命令后才 ready(Pi 在所有 session_start handler 返回前不读 stdin)；不写用户/项目 mcp.json，存在同名覆盖则拒绝启动。子进程环境仍剥 `LARK_`/`FEISHU_*`,只回填固定的 `LARKSUITE_CLI_PROFILE` 给非消息类 `lark-cli`。永不丢消息,改这里必须跑 pi.test.mjs。
- **无人值守交互**:runtime 发来的需要人答复的请求(Pi 扩展 dialog、Codex/TraeX server request、Claude `control_request`)在 adapter 里立即按协议拒绝或取消，记一条 `agent.interaction_declined` activity,不转给人：全局只有一个 runtime,等人回答会卡住所有聊天，进程重启后也无从恢复。模型要问人就用 `choices`,答案作为新消息进来。Codex `approvalPolicy: never` 和 Claude `--permission-prompts none` 已在 runtime 内部拒绝绝大多数这类请求，adapter 只兜底。Pi 启动期间的 dialog 没法回答，直接启动失败。
- **VolcAgent 状态机**(volc.mjs):`/model ark` 通过 Sessions API + SSE 运行，仅接受 `config.type=self_hosted` 的 Environment。seed session 只提供锁定的 Agent/Environment，每个 daemon 新建独立 session。先 POST user.message、再挂 stream，并用 history + event.id 补洞；只有看到 POST 返回 event id 对应的 user.message echo 后才接纳本轮输出。断线/重启用持久 turn fence 恢复；POST acceptance unknown 时 quarantine 旧 session，clone fresh 并原子轮换 epoch/authority/session 后才 drain。官方 Environment Worker 是唯一工具执行面，可在同一个原生 turn 中多次用 bash 调本机 `lark-cli`；`requires_action` 后由 Worker 回写 `user.tool_result` 继续，`end_turn` 才完成。daemon 不执行工具、不转发 `agent.message`。云沙箱严格 JSON bridge 不再支持。活跃 turn 的新消息一律排下一轮；不同 chat/thread 禁止合并。
- **出站只有一条路径**:所有 runtime 的消息动作都是 Agent 工具 `send_message` / `notify_owner` / `reply_message` / `react_to_message` / `retract_message`(send/reply 正文五选一:`markdown`、`file_path`、`file_key`、`card`、`choices`),只读的 `list_chats` / `list_chat_messages` / `search_messages` / `list_thread_messages` / `get_message_media`,以及 `read_openviking_session_context` / `read_meeting_inbox`。定义在 `actions/tools.mjs`,实现只在 `actions/service.mjs`;MCP 适配器只转发到 `<dataDir>/actions.sock`(`GET /v1/tools`、`POST /v1/call`,`x-agent-authority` 头),runtime 子进程经 `PERSONAL_AGENT_SOCKET` / `PERSONAL_AGENT_AUTHORITY` 拿到地址与运行权。`decision_id` 只取输入行的 `event=`(`msg=` 只是回复目标),Core 解析成唯一的 `(instance, event_id, seq, scope_key)`,多个实例同名就拒绝(`decision_ambiguous`)直到给出 `decision_instance`,不取最新;新鲜度按 `scope_key`(聊天=会话，非聊天=instance+subject)比 Core `seq`,发送前复查最初解析出的那条事件;幂等键用 decision/response 各自的 `(instance, event_id)`。谁能发到哪只在 `ActionService.authorize` 判断:非聊天事件只能 `notify_owner`(不带 chat id,Core 发到主 IM `VIKA_CHANNEL` 上 owner 的私聊;owner 来自 Connector `check` 结果:飞书=profile 的 lark-cli user 登录,微信=扫码账号),`source` 只在聊天 decision 时认;manifest 标 `approval: true` 的动作(邮件回复)模型永远不能直接执行:`proposeReply` 把草稿发到主渠道的 owner 私聊，形式按主渠道能力选。能显示卡片(飞书):可编辑卡片(登记为只有 owner 能答、只认第一次、3 天过期的 question,草稿存在 `lark_cards.question_json`),owner 点发送后由 `settleApproval` 按卡片上的文字发(key 按卡片)并更新卡片。不能显示卡片(微信等):`proposeByMessage` 先在 `approvals` 表(`approvals.mjs`,编号即 AUTOINCREMENT 行号，永不复用)建一行再发带编号的文字草稿;owner 回「发送 N」「不发 N」「修改 N 正文」由 Harness 像 slash 命令一样拦下(`approvalReply` → `ActionService.matchApprovalReply`:整条消息匹配、编号存在、同一 IM、发送人是该草稿的 owner,否则当普通消息),`answerApproval` 发信(key 按审批行)/作废/改正文并回 owner 一句结果;同一封邮件的新草稿把旧的待确认草稿标为 superseded。两条路都经 `sendApproved` 发给草稿上那份收件人(`to`,Connector 核对与邮件的回信收件人完全一致才发),只发一次，草稿列出全部收件人(超过 20 个的邮件 `data.reply` 只给数量，不能回),再经 `Harness.deliverNote` 在 owner 私聊里给模型补一行实际结果(`[mail reply sent] {...}`,不带 seq);授权是 owner 的那次点击或回复，不是 decision(旧 owner 消息在自己 scope 里永远新鲜，不能当授权)。回复按目标记账,回邮件不借 decision 的 chat。ActionService 按目标 id(connector_events / outbox)、显式 `source` 或唯一支持方路由到 Connector,按 manifest 的 `actions`/`queries` 决定提供哪些工具、接受哪些正文;authority、freshness fence、attribution、mention 解析、文件快照、临时 OnIt reaction、卡片登记、liveness 都在这里。唯一的 `outbox` 表(按 connector + 幂等键唯一)与 `outbound` journal 行同事务预留/结算;重复请求返回已有结果,`UNCERTAIN` 只在 manifest 声明 `idempotent` 时用同一 key 重试。daemon 自己的回复(slash、失败/回退通知)走 `replyToEvent`,同一 outbox。prompt 禁止用 `lark-cli` 发消息;`lark-cli` 只留给文档、日历等非消息操作。search 走 user 身份,list/thread 可选 `as:"user"`,读到的属于用户私有数据,不得转述到别的 chat。内容行只留资源占位(`[image image_key=...]` / `[file file_key=... file_name=...]` 等),细节见 `packages/daemon/agent/lark-message-formats.md`。Volc 例外:Worker 访问不到 socket,仍由 Worker bash 调 `lark-cli`,也因此不支持微信。
- **Email Connector**(`src/email/`):IMAP `EXAMINE` + `BODY.PEEK[]` 只读 INBOX,从不改 flag;UID 游标与回信所需头存 `<dataDir>/email/state.sqlite3`,首启从 UIDNEXT 开始,停机后最多补最新 50 封;IDLE 9 分钟续一次,无 IDLE 时 60s 轮询;连接出错直接让 worker 退出,由 ConnectorManager 退避重启。事件 `kind=email.received`/`email.list`(List-Id/Precedence),`msg=mail:<账号>:<uidvalidity>:<uid>`(回复目标)、`event=imap:<账号>:<uidvalidity>:<uid>`(`<账号>`是地址摘要 `accountTag`:UID 只在一个邮箱内唯一，实例可能换邮箱；游标也按账号存)、`subject=thread:gmail:<X-GM-THRID>` 或 `thread:mid:<References 首个 id 的摘要>`;`Auto-Submitted: auto-replied` 的自动回复和自己发的回信(Message-ID `vika.<hash>@`)跳过,`auto-generated` 的通知照常上报。服务器会在 FETCH 里夹带别的邮件的 flag 变更，`ImapConnection.fetch` 只返回请求的 UID,游标只按本批推进。邮件内容全是发件人可控的：上报前一律限长(标题 300、显示名 100、地址 254、每个正文部分只读 256 KB、单个头 64 KB),解析都是线性的；单封邮件解析或构造事件失败就记 `email_unreadable` 跳过，游标照走，不重试。SMTP 回信纯文本,465 直连 TLS、否则 STARTTLS,不幂等。一个实例可接多个邮箱：每个邮箱是一个 Connector instance(`email-<名字>`,`connectorInstances` 展开),各跑一个 worker(argv 是类型 `email`,配置里带 `instance` 和自己的账号文件),共用 `<dataDir>/email/state.sqlite3`(游标按账号存，回信只认本账号的 `mail:<账号>:` id);ActionService 按邮件所在 instance 路由，`source=email` 会解析到目标邮件的 instance,审批卡片写明发件邮箱(`data.reply.from`)。账号文件 0600,manifest `emailAccounts: [{id, config}]` → `VIKA_EMAIL_ACCOUNTS_JSON`;`vika login email`/setup 写到 `~/.vika/email/<实例>/<邮箱名>.json`,保存前用 `verifyAccount`(IMAP 登录 + 只读 EXAMINE + SMTP AUTH,不发信)验证。IMAP/SMTP/MIME 都是标准库实现的最小子集。
- **卡片回调**:`card-messages.mjs` 在 SQLite 登记可信工具发出的卡片与目标话题；`card.action.trigger` 经 Harness 归一化为 `msg=ca_... card=om_...`，前者是卡片交互事件的内部 message id,后者用于真实飞书 reply/reaction。单选题按答题人、期限和首次答案校验，回调 token 不进日志或模型。上传校验和冻结文件快照见 `actions/content.mjs`。
- **群聊 burst 无 durable replay**:400ms 窗口内进程停止或崩溃，已落库但未喂给 runtime 的消息会漏处理。
- **Activity 流水**:daemon 和 CodexAgent 都写 `activities` 表(store.recordActivity),daemon 在 `/api/activity` 提供 JSON,web 包只做代理和渲染(public/activity.js)。

## 命令

```bash
npm test            # node --test,全部测试(daemon + web)
npm run check       # node --check 全部源文件
npm run start:daemon / start:web
node scripts/build-release.mjs [--all] [--download-base URL]   # 打安装包(只含已提交代码)到 dist/
sh scripts/install.sh --file dist/vika-<版本>-<平台>.tar.gz     # 装到 ~/.vika,和用户同一条路径
node scripts/publish-release.mjs   # 传到发布桶(VIKA_TOS_BUCKET/ENDPOINT/ACCESS_KEY),latest 最后写
vika status / vika logs <id> / vika restart [id]
```

安装包 = git archive 的代码 + `npm ci --omit=dev` 的依赖 + 官方 Node(版本在根 package.json `vika.node`) + 目标平台的 lark-cli 二进制(按 npm 包自带 checksums.txt 校验) + `release.json`(版本、平台、downloadBase)。Vika 用安装包里的 pm2(`bin/pm2`,由包内 Node 运行),`PM2_HOME=~/.vika/pm2`,不碰用户的 pm2。ecosystem 的 `interpreter` 是包内 Node;PATH 以调用者的为先,系统目录只作兜底。updater(`publisher.mjs`)只下载已发布版本:读 `<downloadBase>/latest` → 清单 → 核对 SHA-256/大小 → 解包 → 用包内 Node 冒烟 → 切 `current`;升级完从新版本重启自己(`scheduleUpdaterRestart`:分离的 shell 在 pm2 杀进程树前就已脱离)。测试桶是私有的:`VIKA_TOS_ACCESS_KEY` 会作为 `x-tos-access` 带上,换公开桶后删掉 `downloadHeaders` 和 install.sh 里那段。

`vika` 命令在 `packages/cli`(bin 按子命令懒加载，`setup`/`help` 不需要 manifest):`setup` 问完全部问题、先用 daemon 的 loader 校验将写入的 manifest，再扫码(飞书用官方 SDK 的 `registerApp` 建应用，`lark-app.mjs`；手写的同一接口客户端每次都卡在 pending，别换回去；lark-cli 写 `vika-<id>` profile 并授权 owner;微信 `loginWeixin`;邮箱 `email.mjs` 问地址和专用密码、当场验证，不扫码),最后写 `~/.vika/config.json` 并启动。已有实例时 setup 先问新建还是修改：修改走同一套逐项提问(`askPlan` 的 `current`,每项默认现值，实例名不可改),邮箱是菜单(再接一个 / 换密码 / 移除，`planMailboxes`),主渠道单独一问(默认飞书),确认改动后只给新接的 IM 扫码，写配置并重启;新接飞书/微信后在那里打招呼(微信经 `greetWeixin`,只能发给扫码的 owner)。接入 IM 只在 setup;`vika login <lark|weixin|email> [实例]` 只给已接入的重新授权(微信重扫、飞书重授权用户身份、邮箱换密码)。`start/stop/restart/status` 只操作 `~/.vika/current` 这份已安装 release,不拉代码;`upgrade` 才走 updater。pm2 的启动与就绪检查在 `packages/updater/src/pm2.mjs`,updater 与 CLI 共用;updater 每次请求都重读 manifest(`loadTargets`),新加的实例不用重启 updater。

## 运行时事实(排查问题先看这里)

- **工作区改动不会生效**:线上跑的是 `~/.vika/releases/<version>` 下的安装包(Vika 自己的 pm2)，配置默认来自 `~/.vika/config.json`。代码要 commit、打包、发布后再 `vika upgrade` 才会上线。
- **运行数据**:`<dataDir>/vika.sqlite3`(activities / connector_events / outbox / cognition_journal 表)。查一次交互到底发生了什么,先 `sqlite3` 查 activities;某次出站的状态和重试看 outbox。每次 Agent 工具调用打一行 `agent_tool` 日志(tool/via/runtime/connector/outcome/code/decisionSeq/newerSeq/responseSeq/outboxId/attempt,不含正文和原始 id),被拦下的投递另记 `delivery.blocked` activity;入站 `event_delivered` 带 seq,可与之对齐。
- **模型侧真相**:codex rollout 在 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,记录模型实际看到的输入和工具调用顺序,是 daemon activity 之外的第二证据源。
- **effort 校验与失败通知**:`/effort` 按 `model/list` 里当前模型的 `supportedReasoningEfforts` 校验(不支持的档位如 minimal 会让每个 turn 都 400);turn failed 时 daemon 解包 API 错误(`turnErrorText`)记入 activity,并经 `notifyTurnFailure` 引用回复发信人。
- **禁止自部署**:system-prompt 明确禁止 Lark 里的 codex 对 Vika 自身执行打包/安装/pm2 操作,自升级只能 `vika upgrade <自己>`——`pm2 delete` 会连带杀掉它自己所在的进程树,部署会死在 `pm2 start` 之前(2026-07-17 发生过)。
- **关机排水与 mid-turn 会话降级**:shutdown 先有界等待活跃 turn 完成(≤12s,预算含在 shutdownTimeoutMs 内)再杀 backend;若仍在 turn 中被杀,runtime 会 `store.markOwnedSessionUnresumable` 把已存 session durably 降级,下次启动开 fresh session + OV context,而不是 resume。原因:resume 被 mid-turn 打断的 transcript 时 Claude CLI 会给悬空 tool call 补拒绝标记,消息历史被改写,整个 prompt cache 前缀按 cache-write 价全量重写(2026-08 实测单实例一天烧掉 ~9M write tokens);codex 同理还有重复输入风险。
- **OV context**:fresh native session 只接 OV archive overview + live messages；同一 native session 不再注入 journal delta。SQLite journal 仅为投递账本和同步 outbox；不得恢复为模型历史来源。
- **steer 语义(已知且接受)**:`turn/steer` RPC 成功只代表 codex 收下了消息,实际注入要等当前推理步(reasoning + tool call)结束,还有约 6s 每轮的注入开销。所以 turn 进行中来的消息,竞态窗口约一个模型步(10-15s),模型正在发的回复拦不住。除非明确要求改成 turn/interrupt + 合并重发,否则不要"修"这个。

## 约定

- 主要使用 Node 标准库，微信扫码使用 `qrcode-terminal`(SQLite 用 node:sqlite，托管 Pi 要求 Node >= 22.19.0)。加依赖前先想清楚,大概率不需要。
- ESM `.mjs`,测试用 node:test,不引测试框架。
- 日志安全不变量:不落敏感内容——`redactSensitive` / `opaqueRef` 包一切外部输入;codex 子进程环境剥掉 `LARK_/FEISHU_*`;HTTP 只绑 loopback 且校验同源。飞书消息正文一律视为不可信输入。
