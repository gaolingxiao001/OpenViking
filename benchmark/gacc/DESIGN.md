# GACC-Bench 集成方案

这份文档同步飞书 Wiki 中的 GACC-Bench 方案。第一阶段目标是做一个可控、
可重复、可解释的压缩评测集，用来判断 OpenViking 压缩是否伤害关键信息保留。

## 为什么先用 GACC-Bench

TAU2 更适合看端到端 Agent 任务成功率，但执行路径有随机性，也不保证每次都触发压缩，
所以很难把分数变化归因到压缩本身。压缩策略还在调优时，先用 GACC-Bench 做更可控的
评测；等压缩策略稳定后，再用 TAU2 做端到端回归。

| 评测集 | 适合测什么 | 优点 / 风险 | 使用建议 |
|-|-|-|-|
| GACC-Bench | 固定 context、goal、QA 下，压缩后关键信息是否还保留。 | 样本结构稳定，可以做 full / no-compression / compressed 对照；更容易定位压缩策略是否伤害回答质量。 | 第一阶段优先使用。 |
| LoCoMo（按 GACC 协议使用） | 长对话原文在压缩后还能不能回答原有 QA。 | 数据不用改：保留原始 sessions、questions、gold answers、question type；只把使用方式从 memory ingest/retrieval 改成 full-context vs compressed-context 对照。 | 作为长对话压缩补充集。 |
| TAU2 | 端到端 Agent 任务完成率。 | 任务执行路径会波动，也不确定每次是否触发压缩；不适合当作压缩策略的第一层指标。 | 压缩策略稳定后，用来做端到端回归。 |

## 核心目标

这个 benchmark 要回答一个问题：OpenViking 收到固定上下文后，在不同压缩比例下，
是否还能正确回答 GACC-Bench 的问题；和不压缩 baseline 相比，得分下降多少。

目标流程不是只调用一个模型做摘要，而是尽量覆盖 OpenViking 的真实压缩链路：
写入 context -> 按配置触发压缩 -> 基于问题回答 -> judge 对比 gold answer。

## 1. 解析层

解析 GACC-Bench JSONL，校验 context、goal、questions、gold answer。

每条样本至少要校验：

- `dataset`
- `context_id`
- `context`
- `goal_id`
- `goal`
- `questions`
- `question_id`
- `question`
- `gold_answer` 或 `original_gold_answer`

官方 GACC-Bench 数据不放进 OpenViking 仓库，运行时传入路径。
解析层额外接受 `LoCoMo` 和 `LoCoMo-*` / `locomo_*` 子集名，并在记录与报告里保留子集分组。
LoCoMo 使用原始 `conversation.session_N` + `qa[]` 结构：每个 session message 解析成一个
turn，`speaker_a -> user`、`speaker_b -> assistant`，保留 speaker 前缀和 session 时间；不把整段
conversation 塞进一个 synthetic assistant `SOURCE_CONTEXT`。
日期同时写入消息正文，确保 summary 和 retained 都能看到时间信息；过滤 category=5，
其他题目保留原始 ID 和 gold answer。
这里不是改 LoCoMo 数据，而是改评测协议：同一份对话原文、问题和 gold answer 同时跑
`-1` no-compression/full-context baseline 和多个 compressed 条件，比较准确率下降。

## 2. Eval 层

流程：

1. 写入 context。
2. 按配置触发压缩。
3. 基于问题回答。
4. judge 对比 gold answer。

Eval 配置与注意事项：

- 模型接入配置统一复用 OpenViking 配置；评测 CLI 只暴露核心生成控制项 `temperature`，并记录实际生效的 provider、model、temperature、max tokens 等配置快照但不记录 secret。
- 隔离 OV 状态：每次 eval 使用独立 user / session / storage，关闭或清理自动记忆，避免记忆提炼污染后续评测。
- 写入 OV 时，GACC 样本仍写 goal + source context；LoCoMo 样本按解析出的多轮 turns 写成真实 `user_query` / `assistant_step`。
- 压缩方法可插拔：`target_ratio` 定义压缩正文预算；OV adapter 使用 20% raw retained budget + 80% `summary_tokens`。首轮不加 benchmark 输出上限，超预算才 full rewrite 并限制输出；重试后仍超预算或为空，记压缩失败。
- `codex-local-summary` adapter 使用同样的 20% / 80% 预算。LoCoMo 按真实多轮构造 prompt，retained 按 Codex local 规则选择最近真实 user messages；OV 保留 session anchor 和最近 assistant steps，因此多轮场景下不只是 prompt 不同。
- 预算采用 OV 保守 token 估算，不冒充模型 tokenizer；reader 的角色标签、标题和分隔符会产生额外开销，单独计入 `final_tokens`。
- 默认 adapter 使用 OV。
- 所有 adapter 统一输出 `final_messages`、token metrics、`effective_options`。
- smoke 随机抽 2-3 个样本，默认重复 3 次且不压缩；分别统计回答文本和判分的波动，给出经验性重复次数建议。
- 每次运行的 artifact 独立存储，不隐式复用旧回答；SQLite 每条立即落盘，压缩失败也记录全部题目并继续执行。

压缩比例参数：

```bash
--compression-ratios -1,0.5,0.3
```

- `-1`：不压缩，用作 baseline。
- `0 < ratio < 1`：目标 `final_messages` token 数占原始 context token 数的比例。

## 3. 记录展示层

用 SQLite 做主记录，记录：

- 样本
- 压缩方法
- `target_ratio`
- `actual_ratio`
- `effective_options`
- `final_messages` tokens
- 回答
- judge 结果
- 耗时

同时导出 JSONL artifact，方便排查单条样本。

展示层需要对比：

- 不同数据集子集
- 不同压缩比例
- 不同压缩方法

第一版目标：能稳定对比不压缩、0.5、0.3 等条件下的准确率，并看出压缩是否伤害关键信息保留。

