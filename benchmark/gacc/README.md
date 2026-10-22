# GACC-Bench for OpenViking Compression

This directory integrates the GACC-Bench protocol for first-stage OpenViking
compression evaluation. It does not vendor the benchmark data. Pass the official
JSONL file at runtime.

See [DESIGN.md](./DESIGN.md) for the target benchmark requirements, including
OpenViking flow coverage, compression-ratio controls, state isolation, smoke
tests, structured records and report generation.

GACC-Bench evaluates goal-adaptive context compression:

1. The compressor sees the full context, a high-level goal and a token budget.
2. The reader answers the goal's questions using either the full context or the
   compressed context.
3. The judge grades each answer against the reference answer.

The OpenViking runner writes run-isolated artifacts and a structured SQLite record
under the output directory:

```text
benchmark/results/gacc_eval/
├── gacc.sqlite
└── runs/<run-id>/
    ├── compressions/
    ├── answers/
    ├── judgments/
    └── reports/
        ├── metrics.json
        ├── results.jsonl
        └── report.html
```

## Data

Use the official repository or Hugging Face dataset:

```bash
git clone https://github.com/weiting24/GACC-Bench.git /tmp/gacc-bench
```

The useful original JSONL files are:

- `/tmp/gacc-bench/data/GACC-Bench-testmini.jsonl`
- `/tmp/gacc-bench/data/GACC-Bench.jsonl`

Each row must contain:

- `dataset`
- `context_id`
- `context`
- `goal_id`
- `goal`
- `questions[]` with `question_id`, `question` and `gold_answer`

Supported `dataset` values include the official GACC-Bench subsets plus
`LoCoMo` and `LoCoMo-*` / `locomo_*` subset names.

LoCoMo rows may use the native JSON shape with `conversation.session_N` and
`qa[]` instead of GACC's single `context` string. In that case the loader builds
one benchmark sample per conversation, preserves the original multi-turn
`user` / `assistant` message order (`speaker_a -> user`, `speaker_b ->
assistant`), and derives the reader context from those turns. The OV adapter
writes those turns as real session messages before committing, so LoCoMo is not
flattened into one synthetic assistant `SOURCE_CONTEXT` message.
Session dates are also visible in message text for compression and retained
context. Category 5 (adversarial/unanswerable) questions are excluded; other
questions retain their original IDs and reference answers.

Using LoCoMo here changes the evaluation protocol, not the dataset: keep the
original sessions, questions, gold answers and question types. The runner
compares the no-compression/full-context condition with compressed conditions at
explicit target ratios, so the delta measures how much compression hurts answer
quality. Do not route this mode through the original LoCoMo memory-ingest and
retrieval pipeline when the goal is to isolate context compression.

## Smoke Test

Validate the input schema and compression-ratio settings without model calls:

```bash
.venv/bin/python -m benchmark.gacc.run_eval \
  --input /tmp/gacc-bench/data/GACC-Bench-testmini.jsonl \
  --output benchmark/results/gacc_smoke \
  --limit 1 \
  --compression-ratios -1,0.5 \
  --dry-run
```

Run a model-backed smoke evaluation using the VLM in `ov.conf`. Smoke mode
samples a few rows, repeats them, and forces the no-compression baseline
(`-1`) so you can inspect model variance before running compressed conditions:
Smoke defaults to three repeats and reports answer changes separately from
grade changes. The repeat recommendation is a screening heuristic, not a
statistical confidence guarantee.

```bash
.venv/bin/python -m benchmark.gacc.run_eval \
  --input /tmp/gacc-bench/data/GACC-Bench-testmini.jsonl \
  --output benchmark/results/gacc_smoke \
  --smoke \
  --sample-size 3 \
  --repeats 3 \
  --seed 42
```

## Model Settings

Compressor, reader and judge all use the configured OpenViking VLM from
`ov.conf`. Keep provider, base URL, API key, model and token limits in the
normal OpenViking config so benchmark commands stay repeatable and easy to
copy.

For deterministic evals, the runner exposes only `--temperature`:

```bash
.venv/bin/python -m benchmark.gacc.run_eval \
  --input /tmp/gacc-bench/data/GACC-Bench-testmini.jsonl \
  --output benchmark/results/gacc_eval \
  --limit 10 \
  --compression-ratios -1,0.5,0.3 \
  --repeats 1 \
  --temperature 0
```

The SQLite run metadata still records the actual provider, model, temperature,
max tokens and whether an API key was configured, but it never stores secret
values.

## Full Runs

Run the controlled subset:

```bash
.venv/bin/python -m benchmark.gacc.run_eval \
  --input /tmp/gacc-bench/data/GACC-Bench-testmini.jsonl \
  --output benchmark/results/gacc_testmini \
  --compression-ratios -1,0.5,0.3
```

Run the full benchmark:

```bash
.venv/bin/python -m benchmark.gacc.run_eval \
  --input /tmp/gacc-bench/data/GACC-Bench.jsonl \
  --output benchmark/results/gacc_full \
  --compression-ratios -1,0.5,0.3 \
  --repeats 3
```

`-1` means no compression and is the baseline. Ratios between 0 and 1 ask the
adapter to target that share of the original context tokens.

For compressed OV runs, the adapter uses 20% of the target budget as raw
retained-message budget and passes the remaining 80% to OV as `summary_tokens`.
OV first generates without the benchmark output cap. If the summary exceeds the
budget, OV regenerates the complete summary with an output cap and checks it
again. An empty or still-oversized retry is recorded as a compression failure.
Both adapters use OV's conservative token estimator for budget checks, not the
model tokenizer. Summary and retained bodies have separate budgets; role labels,
summary headings and separators add a small overhead to `final_tokens`.

Use `--adapter codex-local-summary` to compare against a Codex-style local
summarization prompt. It keeps the same 20% retained-tail and 80% summary budget
split, then returns the same summary-plus-retained reader context shape as the
OV adapter so the comparison focuses on summary generation quality.
For LoCoMo, Codex-local compacts the actual multi-turn history and retains recent
real user messages according to Codex's local rule. OV retains its session
anchor and recent assistant steps, so the two methods are not prompt-only
variants on multi-turn data.

`gacc.sqlite` is the primary record layer. `metrics.json` and `report.html`
summarize condition and dataset-subset accuracy, token ratios and failures.
`results.jsonl` keeps per-question rows for lightweight debugging.
SQLite writes each result immediately. A failed compression records all of that
sample's questions as failed and does not stop subsequent conditions or samples.
Runs never implicitly reuse earlier answers or judgments; use a new run ID for
each execution.
