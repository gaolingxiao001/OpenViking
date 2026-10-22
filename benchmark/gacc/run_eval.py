# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Run GACC-Bench with OpenViking's configured VLM stack."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any

try:
    from benchmark.gacc import adapters, core, records, report
except ModuleNotFoundError:  # pragma: no cover - direct script execution fallback
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from benchmark.gacc import adapters, core, records, report


def _config_to_dict(config: Any) -> dict[str, Any]:
    if hasattr(config, "model_dump"):
        return config.model_dump(mode="python")
    if isinstance(config, dict):
        return dict(config)
    raise TypeError(f"unsupported VLM config type: {type(config).__name__}")


def load_vlm_config(args: argparse.Namespace):
    from openviking_cli.utils.config import VLMConfig, get_openviking_config

    base = get_openviking_config().vlm
    config = VLMConfig.model_validate(_config_to_dict(base))

    if args.temperature is not None:
        config.temperature = args.temperature
    return config


async def complete(vlm: Any, prompt: str, *, max_tokens: int | None = None) -> str:
    response = await vlm.get_completion_async(prompt=prompt, max_tokens=max_tokens)
    text = core.model_text(response)
    if not text:
        raise RuntimeError("empty model response")
    return text


def answer_artifact_path(
    root: str | Path,
    *,
    condition: str,
    ratio: float,
    repeat_index: int,
    question_id: str,
) -> Path:
    return (
        Path(root)
        / "answers"
        / core.safe_name(condition)
        / f"r{repeat_index}"
        / f"{core.uid('answer', condition, ratio, repeat_index, question_id)}.json"
    )


def judgment_artifact_path(
    root: str | Path,
    *,
    condition: str,
    repeat_index: int,
    question_id: str,
) -> Path:
    return (
        Path(root)
        / "judgments"
        / core.safe_name(condition)
        / f"r{repeat_index}"
        / f"{core.uid('judge', condition, repeat_index, question_id)}.json"
    )


async def answer_question(
    vlm: Any,
    model: str | None,
    bundle: core.GACCBundle,
    question: core.GACCQuestion,
    compression: adapters.CompressionResult,
    root: Path,
    *,
    repeat_index: int,
) -> Path:
    path = answer_artifact_path(
        root,
        condition=compression.condition,
        ratio=compression.target_ratio,
        repeat_index=repeat_index,
        question_id=question.question_id,
    )
    if core.reusable(path, model):
        return path
    meta = {
        "type": "answer",
        "model": model,
        "condition": compression.condition,
        "ratio": compression.target_ratio,
        "question_id": question.question_id,
        "context_id": bundle.context_id,
        "goal_id": bundle.goal_id,
        "repeat_index": repeat_index,
    }
    try:
        answer = await complete(vlm, core.build_reader_prompt(compression.final_context, question))
        core.write_json(
            path, {**meta, "status": "ok", "answer": answer, "finished_at": core.stamp()}
        )
    except Exception as exc:
        core.write_json(path, core.failure("reader", meta, exc))
    return path


async def judge_answer(
    vlm: Any,
    model: str | None,
    bundle: core.GACCBundle,
    question: core.GACCQuestion,
    compression: adapters.CompressionResult,
    root: Path,
    *,
    repeat_index: int,
    answer_path: Path,
) -> Path:
    path = judgment_artifact_path(
        root,
        condition=compression.condition,
        repeat_index=repeat_index,
        question_id=question.question_id,
    )
    if core.reusable(path, model):
        return path
    meta = {
        "type": "judgment",
        "model": model,
        "condition": compression.condition,
        "ratio": compression.target_ratio,
        "question_id": question.question_id,
        "context_id": bundle.context_id,
        "goal_id": bundle.goal_id,
        "repeat_index": repeat_index,
    }
    try:
        answer = core.read_json(answer_path)
        if answer.get("status") != "ok":
            raise RuntimeError("reader failed")
        raw = await complete(
            vlm, core.build_judge_prompt(bundle, question, str(answer.get("answer", "")))
        )
        grade, reason = core.extract_judge_grade(raw)
        core.write_json(
            path,
            {
                **meta,
                "status": "ok",
                "grade": grade,
                "reason": reason,
                "raw_response": raw,
                "finished_at": core.stamp(),
            },
        )
    except Exception as exc:
        core.write_json(path, core.failure("judge", meta, exc))
    return path


def _vlm_snapshot(config: Any | None) -> dict[str, Any]:
    if config is None:
        return {}
    provider = getattr(config, "provider", None) or getattr(config, "default_provider", None)
    if provider is None:
        resolver = getattr(config, "_resolve_provider_name", None)
        if callable(resolver):
            try:
                provider = resolver()
            except Exception:
                provider = None
    return {
        "provider": provider,
        "api_base": getattr(config, "api_base", None),
        "model": getattr(config, "model", None),
        "temperature": getattr(config, "temperature", None),
        "max_tokens": getattr(config, "max_tokens", None),
        "api_key_configured": bool(getattr(config, "api_key", None)),
    }


def _effective_config(
    args: argparse.Namespace, compressor: Any | None, reader: Any | None, judge: Any | None
) -> dict[str, Any]:
    return {
        "adapter": args.adapter,
        "compression_ratios": list(args.compression_ratios),
        "repeats": args.repeats,
        "seed": args.seed,
        "smoke": args.smoke,
        "models": {
            "compressor": getattr(compressor, "model", None),
            "reader": getattr(reader, "model", None),
            "judge": getattr(judge, "model", None),
        },
        "vlm": {
            "compressor": _vlm_snapshot(compressor),
            "reader": _vlm_snapshot(reader),
            "judge": _vlm_snapshot(judge),
        },
    }


def _print_summary(metrics: dict[str, Any], output: Path) -> None:
    print("\n=== GACC-Bench summary ===")
    for condition, data in metrics.get("conditions", {}).items():
        overall = data["overall"]
        print(
            f"{condition:<18} questions={overall['correct']}/{overall['evaluated']}/"
            f"{overall['planned']} accuracy={overall['accuracy']}"
        )
    print(
        json.dumps(
            {
                "sqlite": str(output / "gacc.sqlite"),
                "metrics": str(output / "reports" / "metrics.json"),
                "html": str(output / "reports" / "report.html"),
            },
            ensure_ascii=False,
        )
    )


async def _run_question(
    *,
    conn: Any,
    root: Path,
    run_id: str,
    reader: Any,
    judge: Any,
    bundle: core.GACCBundle,
    question: core.GACCQuestion,
    compression: adapters.CompressionResult,
    repeat_index: int,
) -> dict[str, Any]:
    started = time.perf_counter()
    answer_path = await answer_question(
        reader,
        reader.model,
        bundle,
        question,
        compression,
        root,
        repeat_index=repeat_index,
    )
    judgment_path = await judge_answer(
        judge,
        judge.model,
        bundle,
        question,
        compression,
        root,
        repeat_index=repeat_index,
        answer_path=answer_path,
    )
    answer_data: dict[str, Any] = {}
    judgment_data: dict[str, Any] = {}
    error = None
    try:
        answer_data = core.read_json(answer_path)
    except Exception as exc:
        error = str(exc)
    try:
        judgment_data = core.read_json(judgment_path)
    except Exception as exc:
        error = error or str(exc)
    row = {
        "run_id": run_id,
        "dataset": bundle.dataset,
        "context_id": bundle.context_id,
        "goal_id": bundle.goal_id,
        "question_id": question.question_id,
        "condition": compression.condition,
        "target_ratio": compression.target_ratio,
        "actual_ratio": compression.token_metrics.get("actual_ratio"),
        "adapter": compression.effective_options.get("adapter", "unknown"),
        "repeat_index": repeat_index,
        "answer_status": answer_data.get("status", "failed"),
        "judge_status": judgment_data.get("status", "failed"),
        "grade": judgment_data.get("grade"),
        "source_tokens": compression.token_metrics.get("source_tokens"),
        "target_tokens": compression.token_metrics.get("target_tokens"),
        "final_tokens": compression.token_metrics.get("final_tokens"),
        "latency_ms": (time.perf_counter() - started) * 1000,
        "error": error or answer_data.get("error") or judgment_data.get("error"),
        "answer": answer_data.get("answer"),
        "judge_reason": judgment_data.get("reason"),
        "raw_judge_response": judgment_data.get("raw_response"),
        "artifact_paths": {
            "answer": str(answer_path),
            "judgment": str(judgment_path),
        },
        "effective_options": compression.effective_options,
    }
    records.record_result(conn, row)
    return row


async def run(args: argparse.Namespace) -> dict[str, Any]:
    bundles = core.load_gacc_jsonl(args.input, limit=args.limit or None)
    if args.smoke:
        bundles = core.select_smoke_bundles(bundles, sample_size=args.sample_size, seed=args.seed)
        args.compression_ratios = (-1.0,)
    info = {
        "run_id": args.run_id,
        "input": str(Path(args.input).resolve()),
        "input_sha256": core.sha256_file(args.input),
        "contexts": len({bundle.context_id for bundle in bundles}),
        "goals": len(bundles),
        "questions": sum(len(bundle.questions) for bundle in bundles),
        "compression_ratios": list(args.compression_ratios),
        "repeats": args.repeats,
        "smoke": args.smoke,
        "sample_size": args.sample_size if args.smoke else None,
        "seed": args.seed,
        "limit": args.limit or "all",
        "output": str(Path(args.output).resolve()),
    }
    print(json.dumps(info, ensure_ascii=False, indent=2), flush=True)
    if args.dry_run:
        return info

    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    compressor = load_vlm_config(args)
    reader = load_vlm_config(args)
    judge = load_vlm_config(args)
    if not compressor.is_available():
        raise RuntimeError("compressor VLM is not configured")
    if not reader.is_available():
        raise RuntimeError("reader VLM is not configured")
    if not judge.is_available():
        raise RuntimeError("judge VLM is not configured")

    adapter = adapters.OVCompressionAdapter(
        compressor,
        model=compressor.model,
        state_root=root / "ov_state" / args.run_id,
    )
    try:
        rows = []
        with records.connect(root / "gacc.sqlite") as conn:
            records.record_run(
                conn,
                {
                    **info,
                    "effective_config": _effective_config(args, compressor, reader, judge),
                },
            )
            for repeat_index in range(1, args.repeats + 1):
                for bundle_index, bundle in enumerate(bundles, start=1):
                    print(
                        f"[repeat {repeat_index}/{args.repeats}] "
                        f"[{bundle_index}/{len(bundles)}] {bundle.goal_id}",
                        flush=True,
                    )
                    for ratio in args.compression_ratios:
                        compression = await adapter.compress(
                            adapters.CompressionRequest(
                                bundle=bundle,
                                target_ratio=ratio,
                                run_id=args.run_id,
                                repeat_index=repeat_index,
                            )
                        )
                        compression_path = (
                            root
                            / "compressions"
                            / compression.condition
                            / f"r{repeat_index}"
                            / f"{core.uid('compression', bundle.goal_id, ratio, repeat_index)}.json"
                        )
                        core.write_json(
                            compression_path,
                            {
                                "status": "ok",
                                "dataset": bundle.dataset,
                                "context_id": bundle.context_id,
                                "goal_id": bundle.goal_id,
                                "condition": compression.condition,
                                "target_ratio": ratio,
                                "final_messages": compression.final_messages,
                                "token_metrics": compression.token_metrics,
                                "effective_options": compression.effective_options,
                                "raw_response": compression.raw_response,
                                "finished_at": core.stamp(),
                            },
                        )
                        for question in bundle.questions:
                            rows.append(
                                await _run_question(
                                    conn=conn,
                                    root=root,
                                    run_id=args.run_id,
                                    reader=reader,
                                    judge=judge,
                                    bundle=bundle,
                                    question=question,
                                    compression=compression,
                                    repeat_index=repeat_index,
                                )
                            )
            metrics = records.summarize_results(conn, run_id=args.run_id)
        reports_dir = root / "reports"
        core.write_json(reports_dir / "metrics.json", {**info, **metrics})
        core.write_jsonl(reports_dir / "results.jsonl", rows)
        report.write_html_report(reports_dir / "report.html", metrics)
        _print_summary(metrics, root)
        return {**metrics, "run_id": args.run_id, "output": str(root)}
    finally:
        await adapter.close()
        for config in (compressor, reader, judge):
            close = getattr(config, "close", None)
            if callable(close):
                close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    normalized_argv: list[str] = []
    index = 0
    while index < len(raw_argv):
        item = raw_argv[index]
        if item == "--compression-ratios" and index + 1 < len(raw_argv):
            normalized_argv.append(f"--compression-ratios={raw_argv[index + 1]}")
            index += 2
            continue
        normalized_argv.append(item)
        index += 1
    parser = argparse.ArgumentParser(description="Run GACC-Bench with OpenViking VLM config")
    parser.add_argument("--input", type=Path, required=True, help="Path to GACC-Bench JSONL")
    parser.add_argument("--output", type=Path, default=Path("benchmark/results/gacc_eval"))
    parser.add_argument("--run-id", default=core.make_run_id())
    parser.add_argument("--limit", type=int, default=0, help="First N goals; 0 means all")
    parser.add_argument(
        "--compression-ratios",
        default=None,
        help="Comma-separated target ratios; -1 means no compression",
    )
    parser.add_argument(
        "--budgets",
        default=None,
        help="Deprecated comma-separated retention percentages; use --compression-ratios",
    )
    parser.add_argument("--adapter", choices=("ov",), default="ov")
    parser.add_argument("--repeats", type=int, default=1)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--sample-size", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument(
        "--temperature",
        type=float,
        help="Override the configured VLM temperature; use 0 for deterministic evals",
    )
    args = parser.parse_args(normalized_argv)
    if args.limit < 0:
        parser.error("--limit must be >= 0")
    if args.repeats <= 0:
        parser.error("--repeats must be > 0")
    if args.sample_size <= 0:
        parser.error("--sample-size must be > 0")
    try:
        if args.compression_ratios is None and args.budgets is not None:
            args.compression_ratios = ",".join(
                f"{ratio:g}" for ratio in core.parse_budgets(args.budgets)
            )
        args.compression_ratios = core.parse_target_ratios(args.compression_ratios or "-1,0.5,0.3")
    except ValueError as exc:
        parser.error(str(exc))
    return args


def main(argv: list[str] | None = None) -> None:
    asyncio.run(run(parse_args(argv)))


if __name__ == "__main__":
    main()
