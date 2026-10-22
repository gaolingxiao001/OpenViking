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

## 2. Eval 层

流程：

1. 写入 context。
2. 按配置触发压缩。
3. 基于问题回答。
4. judge 对比 gold answer。

Eval 配置与注意事项：

- 模型接入配置统一复用 OpenViking 配置；评测 CLI 只暴露核心生成控制项 `temperature`，并记录实际生效的 provider、model、temperature、max tokens 等配置快照但不记录 secret。
- 隔离 OV 状态：每次 eval 使用独立 user / session / storage，关闭或清理自动记忆，避免记忆提炼污染后续评测。
- 压缩方法可插拔：`target_ratio` 只定义期望 `final_messages` 的总 token 比例；summary、retained、recent user questions 的预算拆分由各 compressor adapter 自己实现。
- 默认 adapter 使用 OV，并预留 Codex local / remote。
- 所有 adapter 统一输出 `final_messages`、token metrics、`effective_options`。
- smoke 随机抽 2-3 个样本重复跑，先看模型波动。

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

