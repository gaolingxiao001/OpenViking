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

The OpenViking runner writes reusable artifacts and a structured SQLite record
under the output directory:

```text
benchmark/results/gacc_eval/
├── gacc.sqlite
├── reports/metrics.json
├── reports/results.jsonl
├── reports/report.html
├── compressions/
├── answers/
└── judgments/
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

```bash
.venv/bin/python -m benchmark.gacc.run_eval \
  --input /tmp/gacc-bench/data/GACC-Bench-testmini.jsonl \
  --output benchmark/results/gacc_smoke \
  --smoke \
  --sample-size 3 \
  --repeats 3 \
  --seed 42
```

## Model Overrides

By default, compressor, reader and judge all use the configured OpenViking VLM.
Use shared overrides for all roles:

```bash
.venv/bin/python -m benchmark.gacc.run_eval \
  --input /tmp/gacc-bench/data/GACC-Bench-testmini.jsonl \
  --output benchmark/results/gacc_eval \
  --limit 10 \
  --compression-ratios -1,0.5,0.3 \
  --repeats 1 \
  --provider openai \
  --api-base "$OPENAI_BASE_URL" \
  --api-key "$OPENAI_API_KEY" \
  --model "$MODEL" \
  --temperature 0
```

Or set a role independently with `--compressor-model`, `--reader-model`,
`--judge-model`, plus matching `--*-provider`, `--*-api-base` and `--*-api-key`
flags when needed.

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

`gacc.sqlite` is the primary record layer. `metrics.json` and `report.html`
summarize condition and dataset-subset accuracy, token ratios and failures.
`results.jsonl` keeps per-question rows for lightweight debugging.
