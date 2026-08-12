# CLAUDE.md

单用户、本机常驻的飞书 Codex Agent。npm workspaces 两个包:`packages/daemon`(飞书订阅 + Codex + SQLite + 内部 API,端口 3738)和 `packages/web`(本机 Activity 页面 + 固定路由代理,端口 3737)。产品行为和飞书权限见 README.md,此处只写改代码需要的东西。

## 架构(steer 模式)

daemon 是一根薄管道,核心数据流:

```
lark-cli event +subscribe (lark.mjs 子进程, NDJSON)
  → daemon.mjs handleEventLine
  → event.mjs normalizeEvent + deterministicFilter(确定性过滤:类型/发送者/时效)
  → commands.mjs(`/` 开头 = 本机 slash 命令:/new /help /model /effort,
      前缀匹配,daemon 直接执行并经 lark.replyMessage 回信,不进 codex 也不进 history)
  → store.mjs ingest(SQLite 去重,inbound 表分配 seq)
  → codex.mjs CodexAgent.deliver(formatInboundLine 压缩成一行)
      空闲 → turn/start;思考中 → turn/steer;启动中 → queue
  → 常驻 codex app-server(JSON-RPC over stdio,全局唯一 thread)
  → codex 自己通过 MCP 工具回飞书(lark-tools.mjs 作为 stdio MCP server 挂进 codex)
```

- **运行时可变 model/effort**:`/model`、`/effort` 写入 meta 表(`setting:codex_model` / `setting:codex_effort`),优先于 env 配置;值随每次 `turn/start` 以 per-turn override 下发(thread/resume 的 config 对运行中的 thread 不生效,别改回去);`/model` 下一轮生效并保留上下文，`/effort` 切换后自动开空 thread，避免旧档位的失败状态污染后续轮次;`/model` 的可选项来自 app-server `model/list`,参数按列表前缀解析。`/new` 走 `rotateSession()`:开空 thread 且不带 history 前缀。

- **全局单线程**:所有 chat 共用一个 codex thread,消息交错进同一上下文,靠行内 `chat=` 标签区分。`policyHash`(system prompt + model + workspace + steer-v1)变化时不再 resume 旧 thread,新 thread 会丢跨会话上下文——改 `packages/daemon/agent/system-prompt.md` 时要意识到这点。
- **CodexAgent 状态机**(codex.mjs):`activeTurnId` / `startingTurn` / `queue` 三态;turn/start 失败 unshift 回队列,steer 撞上 turn 刚结束会 fallback 到 deliver,断线走 `_reconnectLoop` + `thread/resume`。永不丢消息是硬性不变量,改这里必须跑 codex.test.mjs。
- **出站只走 MCP 工具**:`reply_lark_message` / `send_lark_message` / `react_to_lark_message` / `retract_lark_message`（send/reply 支持 `text` 或 `markdown` 二选一），跨群先用 `list_lark_chats` / `list_lark_chat_messages` / `search_lark_messages` / `list_lark_thread_messages` 只读定位上下文(lark-tools.mjs);search 走 user 身份,list/thread 可选 `as:"user"`,读到的属于用户私有数据,不得转述到别的 chat。send/reply 支持可信 open_id 列表 `mention_user_ids`，内部生成真正的飞书 @。代码统一放行支持的 image/file/audio/video/sticker 类型，内容行只留资源占位（`[image image_key=...]` / `[file file_key=... file_name=...]` 等）；富文本 post 的图片同样保留 image_key。看图用 `view_lark_image(message_id, image_key)` 原生返回 MCP image content block；file/audio/video/sticker 还没有对应工具，细节见 `packages/daemon/agent/lark-message-formats.md`。codex 默认不 shell 调 lark-cli；仅当用户明确要求、可信工具尚未覆盖时，按 system-prompt 的 fallback 规则执行等价单条命令（禁 auth/config/admin）。
- **Activity 流水**:daemon 和 CodexAgent 都写 `activities` 表(store.recordActivity),daemon 在 `/api/activity` 提供 JSON,web 包只做代理和渲染(public/activity.js)。

## 命令

```bash
npm test            # node --test,全部测试(daemon + web)
npm run check       # node --check 全部源文件
npm run start:daemon / start:web
./scripts/deploy.sh [git-ref]   # 只部署已提交的 HEAD,先跑测试再切 pm2
pm2 logs lark-daemon --lines 100
```

## 运行时事实(排查问题先看这里)

- **工作区改动不会生效**:线上跑的是 `~/.local/lib/lark-daemon/releases/<version>-<ts>-<commit>` 下的 release(pm2)，配置默认来自 `~/.lark-daemon/deployment.json`。必须 commit 后发布 release 才能让代码上线。
- **运行数据**:`~/.local/share/lark-daemon/lark-daemon.sqlite3`(activities / inbound / turns / conversations 表)。查一次交互到底发生了什么,先 `sqlite3` 查 activities。
- **模型侧真相**:codex rollout 在 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`,记录模型实际看到的输入和工具调用顺序,是 daemon activity 之外的第二证据源。
- **effort 校验与失败通知**:`/effort` 按 `model/list` 里当前模型的 `supportedReasoningEfforts` 校验(不支持的档位如 minimal 会让每个 turn 都 400);turn failed 时 daemon 解包 API 错误(`turnErrorText`)记入 activity,并经 `notifyTurnFailure` 引用回复发信人。
- **禁止自部署**:system-prompt 明确禁止 Lark 里的 codex 对 lark-daemon 自身执行 deploy.sh/pm2 操作——`pm2 delete` 会连带杀掉它自己所在的进程树,部署会死在 `pm2 start` 之前(2026-07-17 发生过)。
- **steer 语义(已知且接受)**:`turn/steer` RPC 成功只代表 codex 收下了消息,实际注入要等当前推理步(reasoning + tool call)结束,还有约 6s 每轮的注入开销。所以 turn 进行中来的消息,竞态窗口约一个模型步(10-15s),模型正在发的回复拦不住。除非明确要求改成 turn/interrupt + 合并重发,否则不要"修"这个。

## 约定

- 纯 Node 标准库,**零 npm 依赖**(SQLite 用 node:sqlite,故 engines >= 22.5)。加依赖前先想清楚,大概率不需要。
- ESM `.mjs`,测试用 node:test,不引测试框架。
- 日志安全不变量:不落敏感内容——`redactSensitive` / `opaqueRef` 包一切外部输入;codex 子进程环境剥掉 `LARK_/FEISHU_*`;HTTP 只绑 loopback 且校验同源。飞书消息正文一律视为不可信输入。
