# lark-daemon

一个单用户、本机常驻的飞书 AI Agent。项目拆成两个可独立迭代和重启的模块：`daemon` 负责飞书订阅、Codex/Claude、SQLite 与内部 API；`web` 只负责本机 Activity 页面和固定路由代理。

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

正式上线跑 `./scripts/deploy.sh`（见「日常运维」）。部署配置集中在 `~/.local/lib/lark-daemon/env`：首次部署时从仓库 `.env` 播种，之后直接编辑该文件并 `pm2 restart` 生效，不随 release 覆盖。健康检查失败会自动回滚到上一个 release（`~/.local/lib/lark-daemon/current` 指向当前生效版本）。

## 交互规则

- 所有聊天统一具有工作区写权限，可让 Codex 在配置的工作区里完成任务；因此只应把 Agent 加入你信任的聊天。
- 所有聊天共享一个全局 runtime/session，不同 chat 的消息会交错进入同一上下文，用每行的 `chat=` 标签区分归属。
- 群聊的 400ms 从首条待处理消息开始计算，后续补充不会重置时间。不同 chat/thread 各自排队，先到期的先开 turn；已有 turn 时继续沿用即时 steer。
- 明确问题、任务、纠正和有效续聊通常会回复；“收到”“谢谢”、闲聊、状态播报、人与人之间的对话、已经有人答好的问题通常保持静默。
- 图片、文件和其他暂不支持的消息不会触发回复。
- 本机 slash 命令（私聊直接发 `/` 开头的消息；群聊需要 `@` 机器人再加命令）由 daemon 直接处理并回复，不经过模型：`/new`、`/help`、`/model [名称]`、`/effort [档位]`。用 `/model claude:sonnet`、`claude:opus`、`claude:haiku` 或 `claude:fable` 切到 Claude；用 `/model codex:<模型 ID>` 切回指定 Codex 模型。跨 runtime 是全局 hard switch：旧 native session 退役，目标 runtime 在第一条真实消息里接上 daemon journal，不会复活两份分叉上下文。隐藏思考和未落盘的非 Lark 工具输出无法继承。`/effort` 与 `/new` 会开启新会话。任何信任聊天里的成员都能执行这些命令，且作用于全局会话。
- 某一轮模型调用失败时，daemon 会程序化地引用回复一条失败提示（含真实报错），消息不会无声消失。

所有出站动作走专用 MCP 工具：`react_to_lark_message`（没有新增信息时用表情轻量回应）、`reply_lark_message`（引用回复/话题）、`send_lark_message`（整聊天，含明确要求的跨 chat 主动发送）、`retract_lark_message`（撤回机器人自己的消息）。send/reply/react 还必须携带其所响应的最新 authenticated `decision_message_id`；sidecar 在执行副作用前读取 SQLite，若同一 chat/thread 已有更高序号的 accepted inbound 就 fail closed，让全局 Agent 根据已有 steer 重判。只读定位上下文用 `list_lark_chats`（解析群名）、`list_lark_chat_messages`（读单个 chat 最近消息，可 `as:"user"` 读机器人不在的会话）、`search_lark_messages`（user 身份跨会话搜索）、`list_lark_thread_messages`（按 thread 读完整话题）；user 身份读到的内容属于用户私有数据，只用于服务发起请求的用户。工具只接受完整 id；发送工具只接受纯文本和可选的可信 `mention_user_ids`，后者会生成真正的飞书 @。Codex 默认不通过 shell 调用 `lark-cli`；仅当用户明确要求、且对应可信工具尚未加载时，才按 system prompt 的 fallback 规则执行等价的单条命令（auth/config/admin 操作始终禁止）。

## 飞书前置条件

飞书应用需要：

1. 使用长连接订阅 `im.message.receive_v1`。
2. 私聊消息权限 `im:message.p2p_msg`（或对应只读权限）。
3. 群聊不 `@` 也要收到消息，需要敏感权限 `im:message.group_msg`；只有 group-at 权限时，平台不会投递普通群消息。
4. 机器人发消息权限 `im:message:send_as_bot`。
5. 获取机器人所在群列表权限 `im:chat:read`。
6. 把机器人加入需要参与的群，并把应用可见范围限制为自己的日常使用范围。

本机的 `lark-cli` 和 `codex` 需要已经登录。daemon 会固定启动时选中的 lark profile，不会跟随后续默认 profile 的变化。

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
pm2 status lark-daemon lark-web
pm2 logs lark-daemon --lines 100
curl http://127.0.0.1:3737/ready
pm2 restart lark-daemon --update-env
pm2 restart lark-web --update-env
./scripts/deploy.sh [git-ref]
```

PM2 分别托管 `lark-daemon` 和 `lark-web`。Web 入口保持为 `127.0.0.1:3737`，并只把 `/api/activity`、`/health`、`/ready` 代理到 `127.0.0.1:3738`；它不读取 SQLite 或 daemon 配置。停止或重启 Web 不会影响飞书监听与回复。部署脚本只发布已提交的 ref，并用本机原子锁避免两个 task 同时切换 PM2。daemon 自身保证单实例，运行状态默认存放在 `~/.local/share/lark-daemon/`，包括 SQLite 全局线程 id、消息去重记录和活动账本。

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
- slash command 和后续消息经过同一条全局 ingress barrier；runtime switch 先等旧 turn 空闲，再 preflight 目标进程，最后原子交接 session 与 Lark tool authority。目标启动失败时仍留在旧 runtime。
- SQLite 只保留一个 active runtime/session。跨 runtime journal 记录 accepted inbound、Lark outbound/control 与 uncertain side effect；它不保存隐藏思考。journal 超过上限时 switch fail closed，先 `/new` 再切。
- 收到的每条消息压缩成一行 `[chat=… msg=… time=… from=…] 正文`；`chat=`/`msg=` 为完整 id（作为工具参数使用），thread 后缀与 `from=` 为短 stub。新线程首轮注入跨聊天历史，以 `--- history above, new messages below ---` 分隔。
- 两个 runtime 都通过 MCP 工具自己发送回复。sidecar 在副作用前校验 active-runtime fence 和 `decision_message_id` freshness，并先写 PENDING journal；成功后 COMMITTED，timeout/crash 保留为 UNCERTAIN。runtime token 是本机单用户进程内的 fencing nonce，不是远程凭证；能读取 daemon SQLite 或进程配置的本机用户，本来就已处于 daemon 的信任边界内。
- raw 飞书事件不会整包落库，避免保存事件 header 中的 token；正文只为会话上下文保留。
- Activity 账本保留脱敏后的短摘要（含收消息、turn 开始/结束、steer、agent 输出）；老记录由网页折叠，不因业务表的清理而消失。
- 单个 turn 没有 watchdog，codex 若长时间不结束一轮，该轮会一直 active（后续消息仍会 steer 进来）。

当前固定为 raw 事件、text 回复；不支持 compact 订阅或 markdown 图片解析。

## 飞书端验收

1. 私聊发一个明确任务，应执行并回复。
2. 私聊只发“收到，谢谢”，应保持静默。
3. 群里不 `@` 发一个尚未解决的问题；Agent 有增量价值时回复。
4. 群里发闲聊或人与人的对话，应保持静默。
5. Codex 空闲时，在同一群聊或话题里快速连发一条任务和一条纠正（间隔小于 400ms）；两条应进入同一个 `turn/start`，最终回复采用纠正后的要求。
6. Agent 思考时立即补一句纠正；该补充会 steer 进同一轮，最终回复应结合它、不发过时答案。
7. 私聊要求 Agent 向另一个已加入群发送测试消息；Agent 应先解析群名，再通过专用工具发送，并在当前私聊确认结果。
