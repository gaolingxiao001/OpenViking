# lark-daemon

一个单用户、本机常驻的飞书 AI Agent。项目拆成三个可独立运行的模块：`daemon` 负责飞书订阅、Codex/Claude、SQLite 与内部 API；`web` 只负责本机 Activity 页面和固定路由代理；`updater` 是 PM2 sibling，从固定的 upstream `main` 发布并滚动 allowlist 内的 daemon。

daemon 是一根薄管道（steer 模式）：`lark-cli event +subscribe` 收到的每条消息被压缩成一行，喂给当前全局 runtime。Codex 使用常驻 app-server，Claude 使用常驻 stream-json stdin/stdout；两边都通过同一套 Lark MCP 工具回复。所有聊天共享一份全局认知，同一时刻只运行一个 runtime。群聊在空闲时先等固定 400ms，把同一 chat/thread 里紧跟着的补充合进首轮；思考中途来的纠正会即时进入当前会话。日常使用不需要 `@`。

## 安装

前置依赖（均为本机命令行工具）：

1. Node.js ≥ 22.5（使用 `node:sqlite`，项目本身零 npm 依赖，无需 `npm install`）。
2. `lark-cli` 已安装并完成 bot 登录（权限见「飞书前置条件」；路径默认 `/opt/homebrew/bin/lark-cli`，可用 `LARK_CLI_BIN` 覆盖）。
3. `codex` CLI 已安装并登录（默认 `/opt/homebrew/bin/codex`，可用 `CODEX_BIN` 覆盖）。
4. 如需切到 Claude，安装并登录 `claude` CLI；路径可用 `CLAUDE_BIN` 覆盖。
5. `pm2`（仅正式部署需要：`npm i -g pm2`；`ecosystem.config.cjs` 假定 node 在 `/opt/homebrew/bin`，Intel Mac 需自行调整）。

首次运行：

```bash
cd lark-daemon
cp .env.example .env   # 按需调整工作区等配置
npm test && npm run check
npm run start:daemon   # 前台验证：curl http://127.0.0.1:3738/ready
```

首次上线用 `./scripts/deploy.sh` 发布 bootstrap release，再启动 updater。此后代码合入并 push 到 upstream `main` 后，只需 `lark-daemon upgrade <instance-id>`：updater 会自行 fetch、打包、跑测试、发布并滚动目标，不再手动执行 deploy（见「日常运维」）。部署配置集中在 `~/.local/lib/lark-daemon/env`：首次发布时从仓库 `.env` 播种，之后不随 release 覆盖。`current` 指向最新发布版本，`rollback` 保留上一个发布版本。

## 交互规则

- 所有聊天统一具有工作区写权限，可让 Codex 在配置的工作区里完成任务；因此只应把 Agent 加入你信任的聊天。
- 所有聊天共享一个全局 runtime/session，不同 chat 的消息会交错进入同一上下文，用每行的 `chat=` 标签区分归属。
- 群聊的 400ms 从首条待处理消息开始计算，后续补充不会重置时间。不同 chat/thread 各自排队，先到期的先开 turn；已有 turn 时继续沿用即时 steer。
- 明确问题、任务、纠正和有效续聊通常会回复；“收到”“谢谢”、闲聊、状态播报、人与人之间的对话、已经有人答好的问题通常保持静默。
- 图片、文件和音视频会以受限资源引用进入 Agent；图片可按消息中的 image_key 用专用工具查看，内容本身不会直接塞进 prompt。未知消息类型不会触发回复。
- 本机 slash 命令在私聊里直接发 `/` 开头的消息，由 daemon 优先处理并回复，不等待当前模型 turn：`/new`、`/help`、`/status`、`/model [名称]`、`/effort [档位]`。`/new` 开启干净会话；prompt 和代码更新通过当前实例自己的 `lark-daemon upgrade <instance-id>` 发布。`/status` 只看主模型是否正在采样及持续时间；主模型等工具或 subagent 时显示空闲。会话变更类命令会先中断旧 turn。用 `/model sonnet`、`opus`、`haiku` 或 `fable` 切到 Claude；其他名称按 Codex 模型处理，例如 `/model gpt-5.6-sol`。跨 runtime 是全局 hard switch：旧 native session 退役，目标 runtime 在第一条真实消息里接上 daemon journal。
- 连续 10 分钟没有成功 outbound delivery 后，daemon 只在后续入站消息的可信 metadata 里加 `idle=<seconds>s`，不会预先 reaction。Agent 仍先按正常规则判断是否要处理；只有决定处理且预计是长工作时，才调用 `react_to_lark_message` 的 `temporary: true` 发一个 `OnIt`。无需回复的群消息和短任务不会产生额外噪音；仅查看后保持静默也不会消费 idle 窗口。MCP sidecar 按 chat/thread 在内存保存 exact `reaction_id`，同 scope 下一次成功的最终文字或 reaction 发出后立即删除，不轮询、不扫 DB。删除失败或进程被 `SIGKILL` 时可能残留，这是 best-effort UX 的明确边界。可用 `LARK_DAEMON_IDLE_REACTION_AFTER_MS=0` 关闭 hint。
- 某一轮模型调用失败时，daemon 会程序化地引用回复一条失败提示（含真实报错），消息不会无声消失。

所有出站动作走专用 MCP 工具：`react_to_lark_message`（没有新增信息时用表情轻量回应；可信 `idle=` 场景下可用 `temporary: true` 发工作中提示）、`reply_lark_message`（引用回复/话题）、`send_lark_message`（整聊天，含明确要求的跨 chat 主动发送）、`retract_lark_message`（撤回机器人自己的消息）。send/reply/react 必须携带最新 authenticated `decision_message_id` 作为 freshness fence；sidecar 在执行副作用前读取 SQLite，若同一 chat/thread 已有更高序号的 accepted inbound 就 fail closed。可选的 `response_to_message_id` 只记录这次 delivery 实际完成了哪条 inbound，供 activity 归属使用，不参与消息分类、路由或回复优先级；它必须属于同一 chat/thread，且不能晚于 freshness fence。只读定位上下文用 `list_lark_chats`（解析群名）、`list_lark_chat_messages`（读单个 chat 最近消息，可 `as:"user"` 读机器人不在的会话）、`search_lark_messages`（user 身份跨会话搜索）、`list_lark_thread_messages`（按 thread 读完整话题）；user 身份读到的内容属于用户私有数据，只用于服务发起请求的用户。工具只接受完整 id；发送工具只接受纯文本和可选的可信 `mention_user_ids`，后者会生成真正的飞书 @。Codex 默认不通过 shell 调用 `lark-cli`；仅当用户明确要求、且对应可信工具尚未加载时，才按 system prompt 的 fallback 规则执行等价的单条命令（auth/config/admin 操作始终禁止）。

## 飞书前置条件

仓库根目录的 [`permission.json`](./permission.json) 是完整功能权限清单。首次配置应用时，在飞书开放平台进入「开发配置 → 权限管理 → 批量开通」，导入该文件；具体格式和审核规则见[官方权限申请说明](https://open.feishu.cn/document/server-docs/application-scope/introduction?lang=zh-CN)。清单覆盖 daemon 可调用的文档、消息、任务、会议等完整能力，并非最小权限集；正式环境应按实际用途删减权限、限制应用可见范围。新增的需审核权限只有在创建应用版本、发布并经管理员审核后才会生效。

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
cp .env.example .env
npm test
npm run check
npm run start:daemon   # 127.0.0.1:3738
npm run start:web      # 127.0.0.1:3737
```

源码目录使用独立的小工作区，避免测试中的 Codex 改到 daemon 自身。正式 PM2 release 安装在 `~/.local/lib/lark-daemon/releases/`，其 `.env` 把工作区设为 `/Users/bytedance/Documents/work`。

## 日常运维

```bash
pm2 status lark-daemon-<instance-id> lark-web lark-updater
pm2 logs lark-daemon-<instance-id> --lines 100
curl http://127.0.0.1:3737/ready
./scripts/deploy.sh [git-ref]
lark-daemon upgrade <instance-id>
lark-daemon upgrade all
```

`deploy.sh` 是首次安装或 updater 控制面协议变更时的 bootstrap 工具，不是日常升级步骤。

`lark-updater` 监听权限为 `0600` 的本机 Unix socket，不开放 TCP 端口，也不读取 Agent 的源码 checkout。它只接受 `LARK_DAEMON_INSTANCE_ID` 和 `all`，从固定的 `https://github.com/ZaynJarvis/lark-daemon.git`、`main` 分支 fetch 到 updater 自有的 bare mirror；请求不能传 SHA、ref、路径、remote 或 shell。新 commit 会先从 Git archive 打成隔离 release，链接共享 env，跑完整测试与 syntax check，全部通过后才原子切换 `current`。随后 updater 从同一份 ecosystem config 同时滚动 daemon 和共享 Web，并校验 `/ready`。相同 commit 的第二次请求直接复用已验证 release。整个发布与滚动过程持有同一把 deploy lock。

### 单实例与多 Agent

当前代码的部署单元是一个独立 Agent：`LARK_DAEMON_INSTANCE_ID` 派生一个 daemon、一个 updater target 和一个 Web target；profile、端口、SQLite dataDir、workspace、model 和 OV config 都必须由该实例专属的持久 env 提供。Web 入口保持为 `127.0.0.1:3737`，只代理这个实例的 loopback target，不接受客户端传入任意 upstream。

这意味着当前 main **不能直接覆盖**仍在运行旧双实例模板的机器。旧模板会在同一份 release 中同时启动 `lark-daemon-zayn` 和 `lark-daemon-sally`，两者是独立 daemon：各自的 lark-cli profile、端口、SQLite、workspace 和 OV config 都隔离，只共享 Web 与 updater。把它直接滚到单实例配置会让未被选中的 Agent 丢失 updater/Web target；旧 env 若缺少实例字段，或 daemon 与 Web 端口复用，也会使 rollout 回滚。

要让一台机器长期跑多个 Agent，推荐的目标模型是“一个 release，多实例 manifest”，不把某个 Agent 作为另一个的子进程：

1. 在持久 deployment manifest 中逐条声明 `id`、显示名、profile、port、dataDir、workspace、OV config 和模型。
2. ecosystem 从 manifest 生成多个独立 daemon；共享 Web 路由全部实例，updater 为每个实例生成 allowlist target，支持单独升级和 `all`。
3. 上线前做 migration/preflight：所有 profile、端口和路径必须唯一；把现有实例完整导入 manifest 后才允许 rollout，禁止隐式丢弃实例。
4. profile 隔离要由运行时强制：可信工具始终显式指定 profile；fallback 需要固定 CLI binary/profile 的 wrapper，并在启动时验证 CLI 支持该隔离机制。仅靠 prompt 或默认 profile 不够。

在 manifest 实现并完成迁移前，单实例配置只适合全新、单 bot 安装；不要用它升级现有多 Agent 主机。

首次安装，或 release 修改了 updater 自身的协议 / target allowlist 时，运行一次 `deploy.sh` + `bootstrap-updater.sh`。普通代码升级只需先把 commit push 到 upstream `main`，再调用 `lark-daemon upgrade <instance-id>`。升级承载当前 turn 的自身进程也由 updater 继续完成，但当前 CLI/模型连接可能随进程退出，结果应用 `/status` 或本机 health check 验收。

Meeting audio 默认关闭。启用时，`LARK_DAEMON_MEETING_AUDIO_ASR_CONFIG_FILE` 必须指向 daemon 用户拥有、权限为 `0600` 的外部 YAML；ASR token 放在该文件里，不放进共享 `.env` 或 PM2 环境。YAML 的 provider 字段由外部 `meeting-asr-poc` 定义。

## Activity 页面

打开 [http://127.0.0.1:3737/](http://127.0.0.1:3737/) 可以查看本机活动账本：消息是否收到、Codex 为什么回复或保持静默、选择了哪种投递方式，以及发送是否成功。

- 活动按真实飞书 chat source 分组；同一 chat 的主消息和 thread 归在一起，只显示脱敏后的短引用。
- 失败保留在原时间位置并标红；没有“需要处理”队列。
- `ignore` 是明确但无色的状态；Agent 回复正文使用蓝色底。
- 今天的交互直接显示；每个来源的旧记录和只含旧活动的来源默认折叠，可继续加载。
- 页面每 5 秒在本机刷新一次，标签页隐藏时暂停；没有外部资源或云端服务。

这些活动作为保留历史的事件账本写入同一个 SQLite。升级时会为已有历史做一次幂等 backfill；普通状态清理不会删除 activity。监听启动记录在新进程接管或正常停止时会收口，因此历史启动仍可见，但只有当前监听显示“进行中”。网页 API 只返回脱敏后的来源/会话引用和裁剪后的正文，不暴露飞书 message/chat ID、Codex session、幂等键或 raw event。

## 可靠性边界

- 消息先写 SQLite（状态直接 DONE），再喂给当前常驻 runtime。Codex 用 `turn/start` / `turn/steer`，Claude 用 persistent stream-json input。
- 400ms 群聊窗口只做 transport batching，不创建 chat 专属的 Codex session、history 或 memory。进程在窗口内停止或崩溃，仍可能让已落库消息没来得及喂给 Codex；这版没有加入 durable replay 或 delivery ledger。
- slash command 和后续消息经过同一条全局 ingress barrier，但命令本身不等待模型；只读命令并行回答，会话变更命令先中断旧 turn。runtime switch preflight 目标进程后再原子交接 session 与 Lark tool authority，目标启动失败时仍留在旧 runtime。
- SQLite 只保留一个 active runtime/session。跨 runtime journal 记录 accepted inbound、Lark outbound/control 与 uncertain side effect；它不保存隐藏思考。journal 超过上限时 switch fail closed，先 `/new` 再切。
- 收到的每条消息压缩成一行 `[chat=… msg=… time=… from=…] 正文`；`chat=`/`msg=` 为完整 id（作为工具参数使用），thread 后缀与 `from=` 为短 stub。新线程首轮注入跨聊天历史，以 `--- history above, new messages below ---` 分隔。
- 两个 runtime 都通过 MCP 工具自己发送回复。sidecar 在副作用前校验 active-runtime fence 和 `decision_message_id` freshness，并先写 PENDING journal；成功后 COMMITTED，timeout/crash 保留为 UNCERTAIN。runtime token 是本机单用户进程内的 fencing nonce，不是远程凭证；能读取 daemon SQLite 或进程配置的本机用户，本来就已处于 daemon 的信任边界内。
- raw 飞书事件不会整包落库，避免保存事件 header 中的 token；正文只为会话上下文保留。
- Activity 账本保留脱敏后的短摘要（含收消息、turn 开始/结束、steer、agent 输出）；老记录由网页折叠，不因业务表的清理而消失。
- 单个 turn 没有 watchdog，codex 若长时间不结束一轮，该轮会一直 active（后续消息仍会 steer 进来）。

当前固定为 raw 事件、text 回复；不支持 compact 订阅。富文本 post 中的图片会作为 image_key 资源引用解析，不解析 markdown 图片语法。

## 飞书端验收

1. 私聊发一个明确任务，应执行并回复。
2. 私聊只发“收到，谢谢”，应保持静默。
3. 群里不 `@` 发一个尚未解决的问题；Agent 有增量价值时回复。
4. 群里发闲聊或人与人的对话，应保持静默。
5. Codex 空闲时，在同一群聊或话题里快速连发一条任务和一条纠正（间隔小于 400ms）；两条应进入同一个 `turn/start`，最终回复采用纠正后的要求。
6. Agent 思考时立即补一句纠正；该补充会 steer 进同一轮，最终回复应结合它、不发过时答案。
7. 私聊要求 Agent 向另一个已加入群发送测试消息；Agent 应先解析群名，再通过专用工具发送，并在当前私聊确认结果。
