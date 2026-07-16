# lark-daemon

一个单用户、本机常驻的飞书 Codex Agent。

它通过 `lark-cli event +subscribe` 接收机器人消息，所有聊天共用同一个全局 `codex exec` 会话（跨聊天连续上下文），先判断“这句话是否值得回复”，再选择普通回复、thread 回复或直接发到当前 chat。日常使用不需要 `@`。

## 交互规则

- 所有聊天统一具有工作区写权限，可让 Codex 在配置的工作区里完成任务；因此只应把 Agent 加入你信任的聊天。
- 所有聊天共享同一个全局 Codex 会话，不同 chat 的消息会交错进入同一上下文，用每行的 `chat=` 标签区分归属。
- 明确问题、任务、纠正和有效续聊通常会回复。
- “收到”“谢谢”、闲聊、状态播报、人与人之间的对话、已经有人答好的问题通常保持静默。
- 图片、文件和其他暂不支持的消息不会触发回复。
- 连续对话通常直接发到 chat；需要引用上下文时普通回复；子话题或已有 thread 使用 thread。

chat 与 message 目标始终由 daemon 固定，Codex 只能选择三种投递方式，不能自行选择群或联系人，也不能直接调用 `lark-cli`。

## 飞书前置条件

飞书应用需要：

1. 使用长连接订阅 `im.message.receive_v1`。
2. 私聊消息权限 `im:message.p2p_msg`（或对应只读权限）。
3. 群聊不 `@` 也要收到消息，需要敏感权限 `im:message.group_msg`；只有 group-at 权限时，平台不会投递普通群消息。
4. 机器人发消息权限 `im:message:send_as_bot`。
5. 把机器人加入需要参与的群，并把应用可见范围限制为自己的日常使用范围。

本机的 `lark-cli` 和 `codex` 需要已经登录。daemon 会固定启动时选中的 lark profile，不会跟随后续默认 profile 的变化。

## 本地开发验证

```bash
cd /Users/bytedance/Documents/work/lark-daemon
cp .env.example .env
npm test
npm run check
```

源码目录使用独立的小工作区，避免测试中的 Codex 改到 daemon 自身。正式 PM2 release 安装在 `~/.local/lib/lark-daemon/releases/`，其 `.env` 把工作区设为 `/Users/bytedance/Documents/work`。

## 日常运维

```bash
pm2 status lark-daemon
pm2 logs lark-daemon --lines 100
curl http://127.0.0.1:3737/ready
pm2 restart lark-daemon --update-env
```

PM2 负责异常重启，daemon 自身保证单实例。运行状态默认存放在 `~/.local/share/lark-daemon/`，包括 SQLite 会话、去重记录和待发送回复。

## Activity 页面

打开 [http://127.0.0.1:3737/](http://127.0.0.1:3737/) 可以查看本机活动账本：消息是否收到、Codex 为什么回复或保持静默、选择了哪种投递方式，以及发送是否成功。

- 需要处理的失败和结果不确定项始终置顶。
- 正在判断、排队或发送的项目排在其后。
- 今天的正常交互展开显示；系统噪声和旧记录默认折叠，可继续加载。
- 页面每 5 秒在本机刷新一次，标签页隐藏时暂停；没有外部资源或云端服务。

这些活动以 append-only 事件写入同一个 SQLite，并与消息、turn、outbox 的状态变更放在同一事务中。升级时会为已有历史做一次幂等 backfill；普通状态清理不会删除 activity。网页 API 只返回脱敏后的会话引用和裁剪后的正文，不暴露飞书 message/chat ID、Codex session、幂等键或 raw event。

## 可靠性边界

- 消息先写 SQLite，再启动 Codex；所有聊天共用一个全局 Codex 会话，因此 Codex turn 全局串行（并发固定为 1），绝不并发 `resume` 同一会话。
- 单一全局 Codex session 持久化于 meta 表，跨聊天连续续接，不使用 `resume --last`；策略变化或会话失效时轮换，进程中断时清空并在下轮用历史重建。
- 收到的每条消息压缩成一行 `[chat=… msg=… time=… from=…] 正文`；新会话首轮注入跨聊天历史，以 `--- history above, new messages below ---` 分隔。
- 思考期间来了新消息，旧答案会暂缓，下一轮结合新消息重新判断。
- 回复使用持久幂等键；进程重启后会恢复安全范围内的待发送项。
- raw 飞书事件不会整包落库，避免保存事件 header 中的 token；正文只为会话上下文保留。
- Activity 账本保留脱敏后的短摘要；老记录由网页折叠，不因业务表的 90 天清理而消失。
- `lark-cli --text` 没有 stdin/file 参数，因此发送瞬间，回复正文会出现在同一 macOS 用户可见的子进程参数中。

当前固定为 raw 事件、text 回复；不支持 compact 订阅或 markdown 图片解析。

## 飞书端验收

1. 私聊发一个明确任务，应执行并回复。
2. 私聊只发“收到，谢谢”，应保持静默。
3. 群里不 `@` 发一个尚未解决的问题；Agent 有增量价值时回复。
4. 群里发闲聊或人与人的对话，应保持静默。
5. Agent 思考时立即补一句纠正；旧答案不应抢先发出。
