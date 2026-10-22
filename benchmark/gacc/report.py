# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Static report generation for GACC-Bench."""

from __future__ import annotations

import html
import json
from pathlib import Path
from typing import Any, Mapping


def _fmt(value: Any) -> str:
    if value is None:
        return "-"
    if isinstance(value, float):
        return f"{value:.3f}"
    return str(value)


def _pct(value: Any) -> str:
    if value is None:
        return "-"
    return f"{100 * float(value):.1f}%"


def _bar(value: Any) -> str:
    pct = 0 if value is None else max(0, min(100, round(100 * float(value))))
    return (
        '<div class="bar">'
        f'<div class="bar-fill" style="width:{pct}%"></div>'
        f"<span>{pct}%</span>"
        "</div>"
    )


def _condition_rows(metrics: Mapping[str, Any]) -> str:
    rows: list[str] = []
    for condition, data in metrics.get("conditions", {}).items():
        overall = data["overall"]
        rows.append(
            "<tr>"
            f"<td><code>{html.escape(condition)}</code></td>"
            f"<td>{overall['correct']}/{overall['planned']}</td>"
            f"<td>{_pct(overall['accuracy'])}</td>"
            f"<td>{_bar(overall['accuracy'])}</td>"
            f"<td>{_fmt(overall['average_actual_ratio'])}</td>"
            f"<td>{_fmt(overall['average_final_tokens'])}</td>"
            "</tr>"
        )
    return "\n".join(rows)


def _dataset_rows(metrics: Mapping[str, Any]) -> str:
    rows: list[str] = []
    for condition, data in metrics.get("conditions", {}).items():
        for dataset, summary in data.get("datasets", {}).items():
            if summary["planned"] == 0:
                continue
            rows.append(
                "<tr>"
                f"<td><code>{html.escape(condition)}</code></td>"
                f"<td>{html.escape(dataset)}</td>"
                f"<td>{summary['correct']}/{summary['planned']}</td>"
                f"<td>{_pct(summary['accuracy'])}</td>"
                f"<td>{_bar(summary['accuracy'])}</td>"
                "</tr>"
            )
    return "\n".join(rows)


def write_html_report(path: str | Path, metrics: Mapping[str, Any]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = html.escape(json.dumps(metrics, ensure_ascii=False, indent=2))
    content = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GACC-Bench Report</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #172033; }}
    h1, h2 {{ margin: 0 0 12px; }}
    h2 {{ margin-top: 28px; }}
    table {{ border-collapse: collapse; width: 100%; margin-top: 12px; }}
    th, td {{ border: 1px solid #d9dee8; padding: 8px 10px; text-align: left; vertical-align: middle; }}
    th {{ background: #f5f7fb; }}
    code {{ background: #f2f4f8; padding: 2px 4px; border-radius: 4px; }}
    .summary {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }}
    .metric {{ border: 1px solid #d9dee8; border-radius: 8px; padding: 12px; }}
    .label {{ color: #667085; font-size: 12px; }}
    .value {{ font-size: 22px; font-weight: 650; margin-top: 4px; }}
    .bar {{ position: relative; height: 24px; background: #eef2f7; border-radius: 4px; overflow: hidden; min-width: 160px; }}
    .bar-fill {{ position: absolute; inset: 0 auto 0 0; background: #3867d6; }}
    .bar span {{ position: relative; z-index: 1; display: block; padding: 3px 8px; color: #172033; }}
    pre {{ background: #101828; color: #eef2f7; padding: 16px; border-radius: 8px; overflow: auto; }}
  </style>
</head>
<body>
  <h1>GACC-Bench Report</h1>
  <div class="summary">
    <div class="metric"><div class="label">Planned</div><div class="value">{metrics.get("overall", {}).get("planned", 0)}</div></div>
    <div class="metric"><div class="label">Correct</div><div class="value">{metrics.get("overall", {}).get("correct", 0)}</div></div>
    <div class="metric"><div class="label">Accuracy</div><div class="value">{_pct(metrics.get("overall", {}).get("accuracy"))}</div></div>
    <div class="metric"><div class="label">Failed</div><div class="value">{metrics.get("overall", {}).get("failed", 0)}</div></div>
  </div>
  <h2>Condition Comparison</h2>
  <table>
    <thead><tr><th>Condition</th><th>Correct / Planned</th><th>Accuracy</th><th>Chart</th><th>Avg Actual Ratio</th><th>Avg Final Tokens</th></tr></thead>
    <tbody>{_condition_rows(metrics)}</tbody>
  </table>
  <h2>Dataset Subsets</h2>
  <table>
    <thead><tr><th>Condition</th><th>Dataset</th><th>Correct / Planned</th><th>Accuracy</th><th>Chart</th></tr></thead>
    <tbody>{_dataset_rows(metrics)}</tbody>
  </table>
  <h2>Raw Metrics</h2>
  <pre>{payload}</pre>
</body>
</html>
"""
    path.write_text(content, encoding="utf-8")
    return path
