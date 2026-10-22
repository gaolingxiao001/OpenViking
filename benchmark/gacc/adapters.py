# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd.
# SPDX-License-Identifier: AGPL-3.0
"""Compression adapters for GACC-Bench."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from benchmark.gacc import core
from openviking.message import TextPart
from openviking.session.retention import RETENTION_MODE_TURN_BUDGET


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
    """OpenViking session-retention adapter for GACC-Bench."""

    name = "ov"
    _RETAINED_BUDGET_RATIO = 0.2
    _SUMMARY_BUDGET_RATIO = 0.8

    _MEMORY_POLICY = {
        "self": {"enabled": False},
        "peer": {"enabled": False},
        "memory_types": [],
        "working_memory": {"enabled": True},
    }

    def __init__(
        self,
        vlm: Any,
        *,
        model: str | None = None,
        session_factory: Any | None = None,
        state_root: str | Path | None = None,
        commit_timeout_seconds: float = 1800.0,
    ) -> None:
        self.vlm = vlm
        self.model = model
        self._session_factory = session_factory
        self._state_root = Path(state_root).resolve() if state_root is not None else None
        self._commit_timeout_seconds = commit_timeout_seconds
        self._service: Any | None = None
        self._ctx: Any | None = None

    async def compress(self, request: CompressionRequest) -> CompressionResult:
        bundle = request.bundle
        source_tokens = core.count_tokens(bundle.context)
        condition = core.target_condition_name(request.target_ratio)
        session_id = self._session_id(request)
        base_options = {
            "adapter": self.name,
            "model": self.model,
            "run_id": request.run_id,
            "repeat_index": request.repeat_index,
            "state_isolation": {
                "namespace": f"gacc/{request.run_id}",
                "user_id": f"gacc-{request.run_id}",
                "session_id": session_id,
                "long_term_memory": "disabled",
                "working_memory": "enabled",
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
        retained_budget_tokens = max(1, int(target_tokens * self._RETAINED_BUDGET_RATIO))
        summary_budget_tokens = max(1, target_tokens - retained_budget_tokens)
        session = await self._create_session(
            request,
            session_id=session_id,
            memory_policy=self._MEMORY_POLICY,
        )
        await session.add_messages_async(self._session_messages(bundle))
        commit = await session.commit_async(
            retention_mode=RETENTION_MODE_TURN_BUDGET,
            keep_recent_turn_count=0,
            retained_message_token_budget=retained_budget_tokens,
            summary_tokens=summary_budget_tokens,
            min_raw_tail_steps=1,
            enable_working_memory=True,
            memory_policy=self._MEMORY_POLICY,
        )
        await self._wait_for_commit(session, commit)
        compressed = await self._read_compressed_artifacts(session, commit)
        final_messages = self._compressed_to_final_messages(compressed)
        final_text = core.final_messages_to_context(final_messages)
        summary_tokens = core.count_tokens(compressed["summary"])
        retained_text = "\n\n".join(
            message["content"] for message in self._retained_to_final_messages(compressed["retained"])
        )
        retained_tokens = core.count_tokens(retained_text)
        final_tokens = core.count_tokens(final_text)
        return CompressionResult(
            condition=condition,
            target_ratio=request.target_ratio,
            final_messages=final_messages,
            token_metrics={
                "source_tokens": source_tokens,
                "target_tokens": target_tokens,
                "retained_budget_tokens": retained_budget_tokens,
                "summary_budget_tokens": summary_budget_tokens,
                "summary_tokens": summary_tokens,
                "retained_tokens": retained_tokens,
                "final_tokens": final_tokens,
                "target_ratio": request.target_ratio,
                "actual_ratio": final_tokens / source_tokens if source_tokens else None,
            },
            effective_options={
                **base_options,
                "mode": "ov_session_retention",
                "budget_owner": "openviking_session",
                "output_contract": "summary_plus_retained",
                "retention": {
                    "mode": RETENTION_MODE_TURN_BUDGET,
                    "keep_recent_turn_count": 0,
                    "retained_budget_ratio": self._RETAINED_BUDGET_RATIO,
                    "retained_message_token_budget": retained_budget_tokens,
                    "summary_budget_ratio": self._SUMMARY_BUDGET_RATIO,
                    "summary_tokens": summary_budget_tokens,
                    "min_raw_tail_steps": 1,
                },
                "commit": self._compact_commit_result(commit),
                "compressed": compressed,
            },
            raw_response=compressed["summary"],
        )

    async def close(self) -> None:
        if self._service is None:
            return
        service = self._service
        self._service = None
        close = getattr(service, "close", None)
        if callable(close):
            await close()

    def _session_id(self, request: CompressionRequest) -> str:
        return "gacc-" + core.uid(
            request.run_id,
            request.bundle.context_id,
            request.bundle.goal_id,
            request.target_ratio,
            request.repeat_index,
        )

    async def _create_session(
        self,
        request: CompressionRequest,
        *,
        session_id: str,
        memory_policy: dict[str, Any],
    ) -> Any:
        if self._session_factory is not None:
            return await self._session_factory(request, session_id, memory_policy)

        if self._service is None:
            from openviking.server.identity import RequestContext, Role
            from openviking.service.core import OpenVikingService
            from openviking_cli.session.user_id import UserIdentifier

            if self._state_root is None:
                self._state_root = Path("benchmark/results/gacc_eval/ov_state").resolve()
            user = UserIdentifier("gacc", core.safe_name(request.run_id))
            self._service = OpenVikingService(path=str(self._state_root), user=user)
            await self._service.initialize()
            self._ctx = RequestContext(user=user, role=Role.USER)

        return await self._service.sessions.create(
            self._ctx,
            session_id=session_id,
            memory_policy=memory_policy,
        )

    @staticmethod
    def _session_messages(bundle: core.GACCBundle) -> list[dict[str, Any]]:
        goal = (
            "GACC goal:\n"
            f"{bundle.goal}\n\n"
            f"Dataset: {bundle.dataset}\n"
            f"Context ID: {bundle.context_id}\n"
            f"Goal ID: {bundle.goal_id}"
        )
        return [
            {
                "role": "user",
                "parts": [TextPart(goal)],
                "message_kind": "user_query",
            },
            {
                "role": "assistant",
                "parts": [TextPart("SOURCE_CONTEXT:\n" + bundle.context)],
                "message_kind": "assistant_step",
            },
        ]

    async def _wait_for_commit(self, session: Any, commit: dict[str, Any]) -> None:
        task_id = commit.get("task_id")
        if not task_id:
            return
        from openviking.service.task_tracker import get_task_tracker

        ctx = getattr(session, "ctx", None)
        account_id = getattr(ctx, "account_id", None)
        user_id = getattr(getattr(ctx, "user", None), "user_id", None)
        task = await get_task_tracker().wait(
            task_id,
            account_id=account_id,
            user_id=user_id,
            timeout=self._commit_timeout_seconds,
        )
        status = getattr(getattr(task, "status", None), "value", getattr(task, "status", None))
        if status != "completed":
            error = getattr(task, "error", "") or getattr(task, "result", "")
            raise RuntimeError(f"OpenViking session commit failed: {status} {error}")

    async def _read_compressed_artifacts(
        self,
        session: Any,
        commit: dict[str, Any],
    ) -> dict[str, Any]:
        archive_uri = commit.get("archive_uri")
        if not archive_uri:
            raise RuntimeError("OpenViking commit did not return an archive_uri")
        retained_messages = await session._read_live_messages_strict()
        summary = await session._archives.read_overview(archive_uri)
        return {
            "summary": str(summary or ""),
            "retained": [message.to_dict() for message in retained_messages],
            "commit": self._compact_commit_result(commit),
        }

    @classmethod
    def _compressed_to_final_messages(cls, compressed: dict[str, Any]) -> list[dict[str, str]]:
        final_messages: list[dict[str, str]] = []
        summary = str(compressed.get("summary") or "").strip()
        if summary:
            final_messages.append(
                {
                    "role": "assistant",
                    "content": "OpenViking summary:\n" + summary,
                }
            )
        final_messages.extend(cls._retained_to_final_messages(compressed.get("retained") or []))
        if not final_messages:
            raise RuntimeError("OpenViking compression artifacts are empty after compression")
        return final_messages

    @classmethod
    def _retained_to_final_messages(cls, retained: list[dict[str, Any]]) -> list[dict[str, str]]:
        final_messages: list[dict[str, str]] = []
        for message in retained:
            content = cls._message_content(message)
            if content:
                final_messages.append(
                    {
                        "role": str(message.get("role") or "message"),
                        "content": content,
                    }
                )
        return final_messages

    @staticmethod
    def _message_content(message: dict[str, Any]) -> str:
        chunks: list[str] = []
        for part in message.get("parts") or []:
            part_type = part.get("type")
            if part_type == "text":
                chunks.append(str(part.get("text") or ""))
            elif part_type == "context":
                chunks.append(str(part.get("abstract") or ""))
            elif part_type == "tool":
                tool_output = str(part.get("tool_output") or "")
                if tool_output:
                    chunks.append(tool_output)
        return "\n".join(chunk for chunk in chunks if chunk).strip()

    @staticmethod
    def _compact_commit_result(commit: dict[str, Any]) -> dict[str, Any]:
        return {
            key: commit.get(key)
            for key in (
                "status",
                "task_id",
                "archive_uri",
                "archived",
                "effective_enable_working_memory",
                "estimated_active_tokens",
                "budget_exceeded",
                "reason",
            )
            if key in commit
        }
