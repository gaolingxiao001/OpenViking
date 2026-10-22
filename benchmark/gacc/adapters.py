# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Compression adapters for GACC-Bench.

The benchmark records a stable adapter contract even while the default
implementation is intentionally lightweight. Future adapters can drive the full
OpenViking session commit path, Codex local compression, or a remote compressor
without changing the record/report layers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from benchmark.gacc import core


@dataclass(frozen=True, slots=True)
class CompressionRequest:
    bundle: core.GACCBundle
    target_ratio: float
    run_id: str
    repeat_index: int


@dataclass(frozen=True, slots=True)
class CompressionResult:
    condition: str
    target_ratio: float
    final_messages: list[dict[str, str]]
    token_metrics: dict[str, Any]
    effective_options: dict[str, Any]
    raw_response: str = ""

    @property
    def final_context(self) -> str:
        return core.final_messages_to_context(self.final_messages)


class OVCompressionAdapter:
    """Default OpenViking compression adapter.

    This first benchmark-facing adapter uses the configured OpenViking VLM and
    the local GACC compression prompt to produce the compact context. It records
    the same public result shape expected from a deeper session-commit adapter:
    ``final_messages``, token metrics and effective options.
    """

    name = "ov"

    def __init__(self, vlm: Any, *, model: str | None = None) -> None:
        self.vlm = vlm
        self.model = model

    async def compress(self, request: CompressionRequest) -> CompressionResult:
        bundle = request.bundle
        source_tokens = core.count_tokens(bundle.context)
        condition = core.target_condition_name(request.target_ratio)
        base_options = {
            "adapter": self.name,
            "model": self.model,
            "run_id": request.run_id,
            "repeat_index": request.repeat_index,
            "state_isolation": {
                "namespace": f"gacc/{request.run_id}",
                "user_id": f"gacc-{request.run_id}",
                "session_id": f"{request.run_id}-{core.safe_name(bundle.goal_id)}-r{request.repeat_index}",
                "long_term_memory": "disabled",
                "artifact_reuse": "explicit_only",
            },
        }
        if request.target_ratio == -1:
            return CompressionResult(
                condition=condition,
                target_ratio=request.target_ratio,
                final_messages=[{"role": "user", "content": bundle.context}],
                token_metrics={
                    "source_tokens": source_tokens,
                    "target_tokens": source_tokens,
                    "final_tokens": source_tokens,
                    "target_ratio": -1,
                    "actual_ratio": 1.0,
                },
                effective_options={**base_options, "mode": "no_compression"},
            )

        target_tokens = core.budget_tokens(bundle, request.target_ratio)
        raw = await self.vlm.get_completion_async(
            prompt=core.build_compression_prompt(bundle, target_tokens),
            max_tokens=target_tokens,
        )
        text = core.model_text(raw)
        if not text:
            raise RuntimeError("empty compression response")
        compact = core.truncate_to_budget(text, target_tokens)
        final_tokens = core.count_tokens(compact)
        return CompressionResult(
            condition=condition,
            target_ratio=request.target_ratio,
            final_messages=[{"role": "user", "content": compact}],
            token_metrics={
                "source_tokens": source_tokens,
                "target_tokens": target_tokens,
                "final_tokens": final_tokens,
                "target_ratio": request.target_ratio,
                "actual_ratio": final_tokens / source_tokens if source_tokens else None,
            },
            effective_options={
                **base_options,
                "mode": "vlm_compression",
                "budget_owner": "adapter",
                "output_contract": "final_messages",
            },
            raw_response=text,
        )
