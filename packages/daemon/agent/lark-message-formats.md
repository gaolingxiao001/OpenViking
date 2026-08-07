# Lark 消息格式参考

只在真的要发文本以外的格式时才读这份文档，短消息直接用 `send_lark_message`/`reply_lark_message` 的 `text` 就够了，别为了看这份文档浪费一轮。

底层都是同一个 `lark-cli`(`im +messages-send` / `+messages-reply`),MCP 工具目前原生透出的是其中两种 `--text`/`--markdown`,其余的仍要走 fallback。

## MCP 原生支持

- **text**(默认): 纯文本,走 `send_lark_message`/`reply_lark_message` 的 `text` 参数。绝大多数场景用这个。
- **markdown**: 需要加粗/链接/嵌图时用 `markdown` 参数代替 `text`(二者互斥,只能给一个)。会被 lark-cli 自动包成 post 格式,图片 URL 会自动解析。@提及仍用同一套 `<at user_id="ou_xxx"></at>` 标签,写法不变。

示例:
```
markdown: "**审核通过** 详情看 [PR #123](https://example.com/pr/123)"
```

## 收图片(MCP 原生支持)

收到的图片消息默认能过滤器(`allowedMessageTypes` 含 `image`),inbound 那一行里图片会显示成占位 `[image image_key=img_xxx]`,不含真实图片内容。要看图时调 `view_lark_image`,参数是那行里的 `message_id` 和 `image_key`(照抄,别猜),返回一个 MCP image content block,直接就能看到图,不用自己再下载/转 base64。

file/video/audio 消息目前还在 `allowedMessageTypes` 之外,会被过滤器丢弃,还没做。

## 仍需 lark-cli fallback 的格式(MCP 未覆盖)

按 policy,只有用户在当前对话里明确要求、且没有更合适的可信工具时才能走 shell fallback,且遵守：id 只用可信元数据里的、一次决策只发一次、带 idempotency key。

- **image / file / video / audio**: 需要先把媒体上传拿到 `img_xxx`/`file_xxx` key(`drive` 或 `im` 域下的上传命令),再传给 `+messages-send --image/--file/--video/--audio`。上传本身是另一个高风险动作(任意文件/URL),没有做进 MCP。
- **post 富文本(原始 JSON)**: `--content '<json>' --msg-type post`,自己拼多段富文本结构(粗体/多图混排/多个链接分区)。一般 `markdown` 就够,只有 markdown 表达不了的复杂排版才用这个。
- **interactive 卡片**: `--content '<json>' --msg-type interactive`,即飞书消息卡片(按钮、多列布局)。风险最高,内容是任意 JSON,发之前必须让用户看过卡片结构再发。
- **share_chat / share_user**: 分享群名片/个人名片,`--content '{"chat_id":"oc_xxx"}' --msg-type share_chat` 或 `share_user`。

命令形状同 `im +messages-send --help` / `im +messages-reply --help`,发之前建议先加 `--dry-run` 看请求体。

## 为什么只做了 markdown

image/file/video/audio 需要先上传媒体,涉及任意文件/URL 抓取,风险和 markdown/text 不是一个量级；interactive/post 是任意 JSON,内容校验和审计逻辑目前只按纯文本设计,直接原生支持这些要先过一遍安全评审。markdown 复用了现成的 at-mention 渲染和长度限制,复杂度最低,先做了这个。
