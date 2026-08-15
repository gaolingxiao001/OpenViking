#!/usr/bin/env python3
"""Media-only stdio adapter for the release-owned Doubao meeting ASR worker.

The daemon owns meeting membership and passes a short-lived ByteView WSS URL in
the start command. This process has no join/leave API and never invokes
lark-cli. stdout is reserved for versioned NDJSON; imported backend logs go to
stderr.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import re
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

MAX_LINE_BYTES = 16 * 1024
MAX_PENDING_FINALS = 256
MAX_FINAL_ATTEMPTS = 31
BV_RATE = 24_000
ASR_RATE = 16_000
UNKEYED_CORRECTION_WINDOW_S = 2.0

PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="lark-daemon meeting ASR worker")
    parser.add_argument(
        "--worker-dir", "--poc-dir", dest="worker_dir", required=True,
        help="release meeting-asr directory",
    )
    parser.add_argument("--config", required=True)
    parser.add_argument("--asr", default="volc")
    return parser.parse_args()


def load_private_config(config_path: Path, yaml: Any) -> dict[str, Any]:
    """Load YAML, or the legacy private .setup.md ASR section.

    Supporting the existing private setup file avoids copying a credential
    into the release or process environment. The value is never logged.
    """
    text = config_path.read_text(encoding="utf-8")
    try:
        value = yaml.safe_load(text)
    except yaml.YAMLError:
        value = None
    if isinstance(value, dict):
        return value
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.strip().rstrip(":：").upper() != "ASR":
            continue
        token = next((item.strip().strip("`") for item in lines[index + 1:] if item.strip()), "")
        if token:
            return {"doubao_api_key": token}
    raise RuntimeError("invalid_asr_config")


def safe_reason(error: BaseException) -> str:
    value = type(error).__name__
    return re.sub(r"[^A-Za-z0-9_.-]", "_", value)[:100]


def is_final_result(event: Any) -> bool:
    return getattr(event, "kind", None) in {"definite", "final"} and bool(
        getattr(event, "text", "")
    )


def _optional_nonnegative_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        normalized = int(value)
    except (TypeError, ValueError):
        return None
    return normalized if normalized >= 0 else None


def _final_identity_aliases(
    event: Any,
    request_id: str,
    session_epoch: str,
    absolute_start_ms: int | None,
    absolute_end_ms: int | None,
) -> tuple[str, ...]:
    """Return provider-scoped aliases for one utterance, never its text.

    Volc responses are cumulative and a later second-pass response may repeat
    or revise an utterance already marked definite.  Provider identity wins;
    The provider exposes the utterance position plus its audio range. We
    register both aliases so a correction is still recognized if only one of
    those fields remains stable.  When neither exists we deliberately return
    no alias: dropping equal text would also drop a legitimate repeated phrase.
    """

    request_scope = str(request_id or "unknown-request")
    session_scope = str(session_epoch or "unknown-session")
    aliases: list[str] = []
    explicit = next((
        getattr(event, name, None)
        for name in ("utterance_id", "utteranceId")
        if getattr(event, name, None) not in (None, "")
    ), None)
    if explicit is not None:
        aliases.append(f"provider:{request_scope}:{explicit}")

    index = _optional_nonnegative_int(getattr(event, "index", None))
    if index is not None:
        aliases.append(f"index:{request_scope}:{index}")

    # Absolute media time remains stable when Volc reconnects and assigns a
    # new provider request id. This alias prevents the reconnect's correction
    # from becoming a second Agent turn.
    if absolute_start_ms is not None or absolute_end_ms is not None:
        aliases.append(
            f"range:{session_scope}:{absolute_start_ms}:{absolute_end_ms}"
        )

    return tuple(dict.fromkeys(aliases))


def _normalized_correction_text(value: Any) -> str:
    return " ".join(unicodedata.normalize("NFKC", str(value or "")).split())


class FinalUtteranceGate:
    """First-final-wins dedupe scoped to one meeting media session."""

    def __init__(self, *, now: Any = time.monotonic) -> None:
        self._seen: dict[str, dict[str, Any]] = {}
        self._unkeyed_recent: dict[str, float] = {}
        self._now = now

    def accept(
        self,
        event: Any,
        request_id: str,
        session_epoch: str = "",
        absolute_start_ms: int | None = None,
        absolute_end_ms: int | None = None,
    ) -> dict[str, Any]:
        aliases = _final_identity_aliases(
            event,
            request_id,
            session_epoch,
            absolute_start_ms,
            absolute_end_ms,
        )
        revision = getattr(event, "sequence", None)
        existing = next((self._seen[key] for key in aliases if key in self._seen), None)
        if existing is not None:
            # The first final is already steering (or waiting for daemon ACK).
            # A later second-pass revision belongs to that same utterance and
            # must not create a second Agent input, even when its text changes.
            existing["latest_revision"] = revision
            return {
                "accepted": False,
                "identity": existing["identity"],
                "revision": revision,
                "reason": "utterance_revision",
            }

        identity = aliases[0] if aliases else None
        if aliases:
            record = {
                "identity": identity,
                "first_revision": revision,
                "latest_revision": revision,
            }
            for key in aliases:
                self._seen[key] = record
        else:
            # Some terminal fallbacks carry no utterance id/index/range. Only
            # in that unsafe-to-identify case, suppress an exact immediate
            # repeat. The short window avoids collapsing a real later "好".
            now = float(self._now())
            self._unkeyed_recent = {
                text: seen_at for text, seen_at in self._unkeyed_recent.items()
                if now - seen_at <= UNKEYED_CORRECTION_WINDOW_S
            }
            normalized = _normalized_correction_text(getattr(event, "text", ""))
            seen_at = self._unkeyed_recent.get(normalized)
            if normalized and seen_at is not None:
                self._unkeyed_recent[normalized] = now
                return {
                    "accepted": False,
                    "identity": None,
                    "revision": revision,
                    "reason": "unkeyed_immediate_text_revision",
                }
            if normalized:
                self._unkeyed_recent[normalized] = now
        return {
            "accepted": True,
            "identity": identity,
            "revision": revision,
            "reason": None,
        }


class Protocol:
    def __init__(self) -> None:
        self.seq = 0

    def emit(self, event_type: str, session: dict[str, Any], **fields: Any) -> dict[str, Any]:
        self.seq += 1
        value = {
            "v": 1,
            "type": event_type,
            "seq": self.seq,
            "session_id": session["session_epoch"],
            "session_epoch": session["session_epoch"],
            "capture_generation": session["capture_generation"],
            **fields,
        }
        line = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if len(line.encode("utf-8")) > MAX_LINE_BYTES:
            raise RuntimeError("protocol_event_too_large")
        PROTOCOL_OUT.write(line + "\n")
        PROTOCOL_OUT.flush()
        return value


class MeetingAsrWorker:
    def __init__(self, args: argparse.Namespace) -> None:
        worker_dir = Path(args.worker_dir).resolve()
        if not (worker_dir / "doubao_asr.py").is_file() or not (worker_dir / "byteview_client.py").is_file():
            raise RuntimeError("invalid_worker_dir")
        sys.path.insert(0, str(worker_dir))

        import numpy as np  # type: ignore
        import websockets  # type: ignore
        import yaml  # type: ignore
        from byteview_client import ByteViewClient  # type: ignore
        from doubao_asr import VolcStreamingASRClient  # type: ignore

        config_path = Path(args.config)
        if not config_path.is_absolute():
            config_path = worker_dir / config_path
        config = load_private_config(config_path, yaml)
        api_key = str(config.get("doubao_api_key") or "").strip()
        if not api_key:
            raise RuntimeError("doubao_api_key_required")

        self.np = np
        self.websockets = websockets
        self.ByteViewClient = ByteViewClient
        self.VolcStreamingASRClient = VolcStreamingASRClient
        self.config = config
        self.api_key = api_key
        self.protocol = Protocol()
        self.session: dict[str, Any] | None = None
        self.stop_event = asyncio.Event()
        self.session_task: asyncio.Task[Any] | None = None
        self.pending_finals: dict[str, dict[str, Any]] = {}
        self.final_utterances = FinalUtteranceGate()
        self.segment_seq = 0
        self.last_audio_at_ms: int | None = None
        self.audio_window_samples = 0
        self.audio_window_nonzero = 0
        self.audio_window_peak = 0
        self.audio_window_sum_squares = 0

    def _resample(self, pcm: bytes) -> bytes:
        if not pcm:
            return pcm
        # TODO: replace this stateless linear interpolation only if live quality
        # shows aliasing; keep the prototype dependency surface unchanged now.
        samples = self.np.frombuffer(pcm, dtype=self.np.int16).astype(self.np.float32)
        count = int(len(samples) * ASR_RATE / BV_RATE)
        if count <= 0:
            return b""
        output = self.np.interp(
            self.np.linspace(0, len(samples) - 1, count),
            self.np.arange(len(samples)),
            samples,
        )
        return output.clip(-32768, 32767).astype(self.np.int16).tobytes()

    def _segment_id(self, source_identity: str | None) -> str:
        assert self.session is not None
        digest = hashlib.sha256(
            json.dumps(
                [
                    self.session["session_epoch"],
                    source_identity or f"unkeyed:{self.segment_seq}",
                ],
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        return "segment_" + digest[:40]

    def _observe_audio(self, pcm: bytes) -> None:
        samples = self.np.frombuffer(pcm, dtype=self.np.int16)
        if not samples.size:
            return
        wide = samples.astype(self.np.int64)
        self.audio_window_samples += int(wide.size)
        self.audio_window_nonzero += int(self.np.count_nonzero(wide))
        self.audio_window_peak = max(
            self.audio_window_peak,
            int(self.np.max(self.np.abs(wide))),
        )
        self.audio_window_sum_squares += int(self.np.dot(wide, wide))

    def _take_audio_health(self) -> dict[str, int | float]:
        samples = self.audio_window_samples
        metrics: dict[str, int | float] = {
            "audio_samples": samples,
            "audio_peak": self.audio_window_peak,
            "audio_rms": round(
                math.sqrt(self.audio_window_sum_squares / samples), 2
            ) if samples else 0.0,
            "audio_nonzero_ratio": round(
                self.audio_window_nonzero / samples, 6
            ) if samples else 0.0,
        }
        self.audio_window_samples = 0
        self.audio_window_nonzero = 0
        self.audio_window_peak = 0
        self.audio_window_sum_squares = 0
        return metrics

    async def handle_command(self, command: dict[str, Any]) -> None:
        name = command.get("command")
        if command.get("v") != 1:
            raise RuntimeError("unsupported_protocol_version")
        if name == "start":
            if self.session_task is not None:
                raise RuntimeError("session_already_started")
            endpoint = str(command.get("media_endpoint") or "")
            if not endpoint.startswith("wss://"):
                raise RuntimeError("secure_media_endpoint_required")
            self.session = {
                "session_epoch": str(command.get("session_epoch") or ""),
                "capture_generation": int(command.get("capture_generation")),
                "meeting_id": str(command.get("meeting_id") or ""),
                "meeting_no": str(command.get("meeting_no") or ""),
                "media_endpoint": endpoint,
            }
            if not self.session["session_epoch"] or not self.session["meeting_id"]:
                raise RuntimeError("invalid_session_binding")
            self.session_task = asyncio.create_task(self.run_session(), name="meeting-asr-session")
            return
        if self.session is None:
            raise RuntimeError("session_not_started")
        if str(command.get("session_epoch") or "") != self.session["session_epoch"]:
            raise RuntimeError("stale_session_command")
        if name == "ack":
            self.pending_finals.pop(str(command.get("event_id") or ""), None)
        elif name == "stop":
            self.stop_event.set()
        else:
            raise RuntimeError("unsupported_command")

    async def run_session(self) -> None:
        assert self.session is not None
        session = self.session
        backend = self.VolcStreamingASRClient(
            self.api_key,
            endpoint=str(self.config.get(
                "doubao_endpoint",
                "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
            )),
            resource_id=str(self.config.get(
                "doubao_resource_id", "volc.seedasr.sauc.duration"
            )),
            packet_ms=int(self.config.get("doubao_packet_ms", 200)),
            end_window_size=int(self.config.get("doubao_end_window_size", 500)),
            enable_nonstream=bool(self.config.get("doubao_enable_nonstream", True)),
            enable_ddc=bool(self.config.get("doubao_enable_ddc", False)),
            hotwords=tuple(str(word) for word in self.config.get("doubao_hotwords", [])),
        )
        audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(
            maxsize=int(self.config.get("volc_audio_queue_size", 256))
        )
        bv = self.ByteViewClient(lark_bin="disabled", lark_profile="disabled")
        listen_task: asyncio.Task[Any] | None = None
        audio_task: asyncio.Task[Any] | None = None
        retry_task: asyncio.Task[Any] | None = None
        health_task: asyncio.Task[Any] | None = None
        backend_started = False

        async def on_result(event: Any) -> None:
            if not is_final_result(event):
                return
            origin = backend.audio_origin_at
            start_ms = (
                int((origin * 1000) + event.start_ms)
                if origin is not None and event.start_ms is not None
                else None
            )
            end_ms = (
                int((origin * 1000) + event.end_ms)
                if origin is not None and event.end_ms is not None
                else None
            )
            decision = self.final_utterances.accept(
                event,
                backend.request_id,
                session["session_epoch"],
                start_ms,
                end_ms,
            )
            if not decision["accepted"]:
                self.protocol.emit(
                    "correction_ignored",
                    session,
                    reason=decision["reason"],
                    asr={
                        "provider": "volc-seedasr-2.0",
                        "result_sequence": decision["revision"],
                        "correction_policy": "first-final-wins",
                    },
                )
                return
            if len(self.pending_finals) >= MAX_PENDING_FINALS:
                self.protocol.emit("degraded", session, reason="final_wal_full")
                self.stop_event.set()
                return
            self.segment_seq += 1
            event_id = self._segment_id(decision["identity"])
            fields = {
                "event_id": event_id,
                "segment_seq": self.segment_seq,
                "text": str(event.text),
                "audio_start_ms": start_ms,
                "audio_end_ms": end_ms,
                "asr": {
                    "provider": "volc-seedasr-2.0",
                    "final": True,
                    "result_sequence": decision["revision"],
                    "correction_policy": "first-final-wins",
                },
            }
            emitted = self.protocol.emit("transcript.final", session, **fields)
            self.pending_finals[event_id] = {
                "event": emitted,
                "sent_at": time.monotonic(),
                "attempts": 1,
            }

        async def on_audio(pcm24k: bytes) -> None:
            self.last_audio_at_ms = int(time.time() * 1000)
            self._observe_audio(pcm24k)
            pcm16k = self._resample(pcm24k)
            if audio_queue.full():
                self.protocol.emit("degraded", session, reason="audio_queue_overflow")
                self.stop_event.set()
                return
            audio_queue.put_nowait(pcm16k)

        async def feed_audio() -> None:
            while True:
                pcm = await audio_queue.get()
                try:
                    if pcm is None:
                        return
                    await backend.feed_pcm(pcm)
                finally:
                    audio_queue.task_done()

        async def retry_finals() -> None:
            while not self.stop_event.is_set():
                await asyncio.sleep(1)
                now = time.monotonic()
                for pending in list(self.pending_finals.values()):
                    if now - pending["sent_at"] < 2:
                        continue
                    if pending["attempts"] >= MAX_FINAL_ATTEMPTS:
                        self.protocol.emit("degraded", session, reason="final_ack_timeout")
                        self.stop_event.set()
                        return
                    event = pending["event"]
                    # Preserve event_id and segment_seq while assigning a fresh
                    # transport seq for the retry.
                    fields = {k: v for k, v in event.items() if k not in {
                        "v", "type", "seq", "session_id", "session_epoch", "capture_generation"
                    }}
                    pending["event"] = self.protocol.emit("transcript.final", session, **fields)
                    pending["sent_at"] = now
                    pending["attempts"] += 1

        async def health() -> None:
            while not self.stop_event.is_set():
                await asyncio.sleep(5)
                self.protocol.emit(
                    "health",
                    session,
                    audio="healthy",
                    asr="healthy",
                    last_audio_at_ms=self.last_audio_at_ms,
                    reconnect_count=0,
                    **self._take_audio_health(),
                )

        try:
            await backend.start(on_result)
            backend_started = True
            bv.ws = await self.websockets.connect(
                session["media_endpoint"],
                max_size=10 * 1024 * 1024,
            )
            await bv.create_session(sample_rate=BV_RATE)
            audio_task = asyncio.create_task(feed_audio(), name="asr-audio-feed")
            retry_task = asyncio.create_task(retry_finals(), name="asr-final-retry")
            health_task = asyncio.create_task(health(), name="asr-health")
            listen_task = asyncio.create_task(bv.listen(on_audio), name="byteview-listen")
            self.protocol.emit("ready", session, audio="healthy", asr="healthy")

            stop_task = asyncio.create_task(self.stop_event.wait(), name="meeting-stop")
            done, _ = await asyncio.wait(
                {listen_task, stop_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
            if listen_task in done and not self.stop_event.is_set():
                try:
                    await listen_task
                except Exception as error:
                    self.protocol.emit("degraded", session, reason=safe_reason(error))
                else:
                    self.protocol.emit("degraded", session, reason="media_stream_closed")
                self.stop_event.set()
            stop_task.cancel()
            await asyncio.gather(stop_task, return_exceptions=True)
        except Exception as error:
            self.protocol.emit("degraded", session, reason=safe_reason(error))
            self.stop_event.set()
        finally:
            # Capture closes first; daemon meeting membership remains untouched.
            try:
                await bv.close()
            except Exception:
                pass
            self.protocol.emit("capture_stopped", session, reason="logical_stop")
            if listen_task is not None:
                listen_task.cancel()
                await asyncio.gather(listen_task, return_exceptions=True)

            if audio_task is not None:
                try:
                    await asyncio.wait_for(audio_queue.join(), timeout=5)
                except asyncio.TimeoutError:
                    pass
                await audio_queue.put(None)
                await asyncio.gather(audio_task, return_exceptions=True)
            if backend_started:
                try:
                    await asyncio.wait_for(backend.finish(), timeout=8)
                except Exception as error:
                    self.protocol.emit("degraded", session, reason=safe_reason(error))

            deadline = time.monotonic() + 2
            while self.pending_finals and time.monotonic() < deadline:
                await asyncio.sleep(0.05)
            for task in (retry_task, health_task):
                if task is not None:
                    task.cancel()
            await asyncio.gather(
                *(task for task in (retry_task, health_task) if task is not None),
                return_exceptions=True,
            )
            self.protocol.emit(
                "stopped",
                session,
                reason="logical_stop",
                unacked_finals=len(self.pending_finals),
            )

    async def run(self) -> None:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=MAX_LINE_BYTES + 1)
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)
        while True:
            if self.session_task is not None and self.session_task.done():
                await self.session_task
                return
            read_task = asyncio.create_task(reader.readline())
            waiting = {read_task}
            if self.session_task is not None:
                waiting.add(self.session_task)
            done, _ = await asyncio.wait(waiting, return_when=asyncio.FIRST_COMPLETED)
            if self.session_task is not None and self.session_task in done:
                read_task.cancel()
                await asyncio.gather(read_task, return_exceptions=True)
                await self.session_task
                return
            line = await read_task
            if not line:
                self.stop_event.set()
                if self.session_task is not None:
                    await self.session_task
                return
            if len(line) > MAX_LINE_BYTES:
                raise RuntimeError("protocol_command_too_large")
            command = json.loads(line)
            await self.handle_command(command)


async def async_main() -> None:
    worker = MeetingAsrWorker(parse_args())
    await worker.run()


if __name__ == "__main__":
    try:
        asyncio.run(async_main())
    except Exception as error:
        sys.stderr.write(f"meeting ASR worker failed: {safe_reason(error)}\n")
        raise SystemExit(1)
