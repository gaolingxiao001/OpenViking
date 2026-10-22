# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""SQLite record layer for GACC-Bench runs."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping

from benchmark.gacc import core

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  input_sha256 TEXT,
  seed INTEGER,
  effective_config_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  dataset TEXT NOT NULL,
  context_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  condition TEXT NOT NULL,
  target_ratio REAL NOT NULL,
  actual_ratio REAL,
  adapter TEXT NOT NULL,
  repeat_index INTEGER NOT NULL,
  answer_status TEXT NOT NULL,
  judge_status TEXT NOT NULL,
  grade TEXT,
  source_tokens INTEGER,
  target_tokens INTEGER,
  final_tokens INTEGER,
  latency_ms REAL,
  error TEXT,
  answer TEXT,
  judge_reason TEXT,
  raw_judge_response TEXT,
  artifact_paths_json TEXT NOT NULL,
  effective_options_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, question_id, condition, repeat_index)
);

CREATE INDEX IF NOT EXISTS idx_results_condition ON results(run_id, condition);
CREATE INDEX IF NOT EXISTS idx_results_dataset ON results(run_id, dataset);
"""


@contextmanager
def connect(path: str | Path) -> Iterator[sqlite3.Connection]:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    finally:
        conn.close()


def _json(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, sort_keys=True)


def record_run(conn: sqlite3.Connection, metadata: Mapping[str, Any]) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO runs (
          run_id, created_at, input_sha256, seed, effective_config_json
        ) VALUES (?, ?, ?, ?, ?)
        """,
        (
            metadata["run_id"],
            metadata.get("created_at") or core.stamp(),
            metadata.get("input_sha256"),
            metadata.get("seed"),
            _json(metadata.get("effective_config")),
        ),
    )


def record_result(conn: sqlite3.Connection, row: Mapping[str, Any]) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO results (
          run_id, dataset, context_id, goal_id, question_id, condition,
          target_ratio, actual_ratio, adapter, repeat_index, answer_status,
          judge_status, grade, source_tokens, target_tokens, final_tokens,
          latency_ms, error, answer, judge_reason, raw_judge_response,
          artifact_paths_json, effective_options_json, created_at
        ) VALUES (
          :run_id, :dataset, :context_id, :goal_id, :question_id, :condition,
          :target_ratio, :actual_ratio, :adapter, :repeat_index, :answer_status,
          :judge_status, :grade, :source_tokens, :target_tokens, :final_tokens,
          :latency_ms, :error, :answer, :judge_reason, :raw_judge_response,
          :artifact_paths_json, :effective_options_json, :created_at
        )
        """,
        {
            "run_id": row["run_id"],
            "dataset": row["dataset"],
            "context_id": row["context_id"],
            "goal_id": row["goal_id"],
            "question_id": row["question_id"],
            "condition": row["condition"],
            "target_ratio": row["target_ratio"],
            "actual_ratio": row.get("actual_ratio"),
            "adapter": row.get("adapter") or "unknown",
            "repeat_index": row["repeat_index"],
            "answer_status": row.get("answer_status") or "failed",
            "judge_status": row.get("judge_status") or "failed",
            "grade": row.get("grade"),
            "source_tokens": row.get("source_tokens"),
            "target_tokens": row.get("target_tokens"),
            "final_tokens": row.get("final_tokens"),
            "latency_ms": row.get("latency_ms"),
            "error": row.get("error"),
            "answer": row.get("answer"),
            "judge_reason": row.get("judge_reason"),
            "raw_judge_response": row.get("raw_judge_response"),
            "artifact_paths_json": _json(row.get("artifact_paths")),
            "effective_options_json": _json(row.get("effective_options")),
            "created_at": row.get("created_at") or core.stamp(),
        },
    )


def _summary(rows: list[sqlite3.Row]) -> dict[str, Any]:
    planned = len(rows)
    evaluated = sum(row["judge_status"] == "ok" for row in rows)
    correct = sum(row["judge_status"] == "ok" and row["grade"] == "CORRECT" for row in rows)
    failed = planned - evaluated
    ratios = [row["actual_ratio"] for row in rows if row["actual_ratio"] is not None]
    final_tokens = [row["final_tokens"] for row in rows if row["final_tokens"] is not None]
    source_tokens = [row["source_tokens"] for row in rows if row["source_tokens"] is not None]
    return {
        "planned": planned,
        "evaluated": evaluated,
        "correct": correct,
        "incorrect": evaluated - correct,
        "failed": failed,
        "accuracy": correct / planned if planned else None,
        "evaluated_accuracy": correct / evaluated if evaluated else None,
        "average_actual_ratio": sum(ratios) / len(ratios) if ratios else None,
        "average_final_tokens": sum(final_tokens) / len(final_tokens) if final_tokens else None,
        "average_source_tokens": sum(source_tokens) / len(source_tokens) if source_tokens else None,
    }


def summarize_results(conn: sqlite3.Connection, *, run_id: str | None = None) -> dict[str, Any]:
    params: tuple[Any, ...] = ()
    where = ""
    if run_id is not None:
        where = "WHERE run_id = ?"
        params = (run_id,)
    rows = list(conn.execute(f"SELECT * FROM results {where}", params))
    conditions = sorted({row["condition"] for row in rows})
    datasets = sorted({row["dataset"] for row in rows})
    return {
        "runs": [
            {
                "run_id": row["run_id"],
                "created_at": row["created_at"],
                "input_sha256": row["input_sha256"],
                "seed": row["seed"],
                "effective_config": json.loads(row["effective_config_json"] or "{}"),
            }
            for row in conn.execute("SELECT * FROM runs ORDER BY created_at")
        ],
        "overall": _summary(rows),
        "conditions": {
            condition: {
                "overall": _summary([row for row in rows if row["condition"] == condition]),
                "datasets": {
                    dataset: _summary(
                        [
                            row
                            for row in rows
                            if row["condition"] == condition and row["dataset"] == dataset
                        ]
                    )
                    for dataset in datasets
                },
            }
            for condition in conditions
        },
    }
