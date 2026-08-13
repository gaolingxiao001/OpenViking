#!/usr/bin/env python3
"""Bridge Feishu ByteView downstream audio to Doubao streaming ASR 2.0."""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import signal
import sys
import time
from pathlib import Path

import numpy as np
import yaml

from byteview_client import ByteViewClient
from doubao_asr import TranscriptEvent, VolcStreamingASRClient


CONFIG_PATH = Path(__file__).with_name("config.yaml")
DOUBAO_API_KEY_ENV = "VOLC_ASR_API_KEY"
BYTEVIEW_RATE = 24000
ASR_RATE = 16000


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def emit(record: dict) -> None:
    print(
        json.dumps(record, ensure_ascii=False, separators=(",", ":")),
        flush=True,
    )


def load_config() -> dict:
    if not CONFIG_PATH.is_file():
        raise FileNotFoundError(
            "missing meeting-asr/config.yaml; copy config.example.yaml first"
        )
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("meeting-asr/config.yaml must contain a mapping")
    if not str(config.get("lark_profile", "")).strip():
        raise ValueError("lark_profile is required")
    return config


def resample_pcm16(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    if src_rate == dst_rate or not pcm:
        return pcm
    samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    output_size = int(len(samples) * dst_rate / src_rate)
    if output_size == 0:
        return b""
    output = np.interp(
        np.linspace(0, len(samples) - 1, output_size),
        np.arange(len(samples)),
        samples,
    )
    return output.clip(-32768, 32767).astype(np.int16).tobytes()


def stable_segment_id(meeting_id: str, event: TranscriptEvent) -> str:
    identity = {
        "meeting_id": meeting_id,
        "index": event.index,
        "start_ms": event.start_ms,
        "end_ms": event.end_ms,
        "text": event.text,
    }
    raw = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return "asr_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


async def run(config: dict, meeting_no: str) -> None:
    api_key = os.environ.get(DOUBAO_API_KEY_ENV, "").strip()
    if not api_key:
        raise ValueError(f"{DOUBAO_API_KEY_ENV} is required")

    queue_size = int(config.get("audio_queue_size", 256))
    if not 1 <= queue_size <= 1024:
        raise ValueError("audio_queue_size must be in 1..1024")
    drain_ms = int(config.get("shutdown_drain_ms", 5000))
    if not 0 <= drain_ms <= 30000:
        raise ValueError("shutdown_drain_ms must be in 0..30000")

    byteview = ByteViewClient(
        lark_profile=str(config["lark_profile"]).strip(),
        lark_bin=str(config.get("lark_bin", "lark-cli")).strip() or "lark-cli",
    )
    asr = VolcStreamingASRClient(
        api_key,
        endpoint=str(config.get(
            "doubao_endpoint",
            "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
        )),
        resource_id=str(config.get(
            "doubao_resource_id", "volc.seedasr.sauc.duration"
        )),
        packet_ms=int(config.get("doubao_packet_ms", 200)),
        end_window_size=int(config.get("doubao_end_window_size", 500)),
        enable_nonstream=bool(config.get("doubao_enable_nonstream", True)),
        enable_ddc=bool(config.get("doubao_enable_ddc", False)),
        hotwords=tuple(str(word) for word in config.get("doubao_hotwords", [])),
    )

    audio_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=queue_size)
    stop = asyncio.Event()
    meeting_id = ""
    segment_seq = 0

    def request_stop() -> None:
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, request_stop)
        except NotImplementedError:
            pass

    async def on_result(event: TranscriptEvent) -> None:
        nonlocal segment_seq
        origin = asr.audio_origin_at
        audio_start = (
            origin + event.start_ms / 1000
            if origin is not None and event.start_ms is not None
            else None
        )
        audio_end = (
            origin + event.end_ms / 1000
            if origin is not None and event.end_ms is not None
            else None
        )
        record = {
            "version": 1,
            "kind": "meeting_asr",
            "result_type": "definite" if event.kind == "final" else "partial",
            "provider": "doubao-asr-2.0",
            "meeting_no": meeting_no,
            "meeting_id": meeting_id,
            "speaker": "unknown",
            "text": event.text,
            "audio_start_ts": round(audio_start, 3) if audio_start is not None else None,
            "audio_end_ts": round(audio_end, 3) if audio_end is not None else None,
            "asr_done_ts": round(event.received_at, 3),
            "tail_latency_s": (
                round(max(0, event.received_at - audio_end), 3)
                if audio_end is not None
                else None
            ),
        }
        if event.kind == "final":
            segment_seq += 1
            record["segment_seq"] = segment_seq
            record["segment_id"] = stable_segment_id(meeting_id, event)
        emit(record)

    async def on_audio(pcm24k: bytes) -> None:
        pcm16k = resample_pcm16(pcm24k, BYTEVIEW_RATE, ASR_RATE)
        if audio_queue.full():
            dropped = audio_queue.get_nowait()
            audio_queue.task_done()
            log(f"[worker] audio queue full; dropped {len(dropped or b'')} bytes")
        audio_queue.put_nowait(pcm16k)

    async def pump_audio() -> None:
        while True:
            pcm = await audio_queue.get()
            try:
                if pcm is None:
                    return
                await asr.feed_pcm(pcm)
            finally:
                audio_queue.task_done()

    listen_task = None
    audio_task = None
    stop_task = None
    asr_started = False
    joined = False
    clean_finish = True
    try:
        meeting_id = await byteview.join_meeting(meeting_no)
        joined = True
        await byteview.connect(meeting_id)
        await byteview.create_session(sample_rate=BYTEVIEW_RATE)
        await asr.start(on_result)
        asr_started = True
        log("[worker] listening; JSONL results are on stdout")

        audio_task = asyncio.create_task(pump_audio(), name="doubao-audio-sender")
        listen_task = asyncio.create_task(
            byteview.listen(on_audio), name="byteview-listener"
        )
        stop_task = asyncio.create_task(stop.wait(), name="signal-waiter")
        completed, _ = await asyncio.wait(
            {audio_task, listen_task, stop_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in completed:
            if task is not stop_task and not task.cancelled():
                error = task.exception()
                if error is not None:
                    clean_finish = False
                    raise error
    finally:
        if listen_task is not None and not listen_task.done():
            listen_task.cancel()
            await asyncio.gather(listen_task, return_exceptions=True)
        if stop_task is not None and not stop_task.done():
            stop_task.cancel()
            await asyncio.gather(stop_task, return_exceptions=True)

        if audio_task is not None and not audio_task.done():
            try:
                await asyncio.wait_for(audio_queue.join(), drain_ms / 1000)
            except asyncio.TimeoutError:
                clean_finish = False
                log("[worker] audio drain timed out")
                audio_task.cancel()
                await asyncio.gather(audio_task, return_exceptions=True)
            else:
                audio_queue.put_nowait(None)
                await audio_task

        if joined:
            try:
                await asyncio.wait_for(byteview.leave_meeting(meeting_id), timeout=6)
            except Exception as error:
                log(f"[worker] leave failed: {error}")
        await byteview.close()

        if asr_started:
            try:
                if clean_finish:
                    await asr.finish()
                else:
                    await asr.abort()
            except Exception as error:
                log(f"[worker] ASR close failed: {error}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Feishu meeting to Doubao ASR worker")
    parser.add_argument("--meeting-no", required=True, help="9-digit Feishu meeting number")
    args = parser.parse_args()
    if not re.fullmatch(r"\d{9}", args.meeting_no):
        parser.error("--meeting-no must be exactly 9 digits")
    try:
        asyncio.run(run(load_config(), args.meeting_no))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        log(f"[worker] fatal: {type(error).__name__}: {error}")
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
