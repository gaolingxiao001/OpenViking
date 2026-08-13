"""Read-only Feishu ByteView realtime audio client."""

from __future__ import annotations

import asyncio
import json
import sys
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit

import websockets

import frontier_pb2
import meeting_realtime_pb2


FRONTIER_SERVICE = 33555721
FRONTIER_METHOD = 1
FRAME_TYPE_NORMAL = 0
FRAME_TYPES_SKIP = {1, 2, 16, 32}


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _now_rfc3339() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _audio_format(sample_rate: int) -> meeting_realtime_pb2.AudioFormat:
    return meeting_realtime_pb2.AudioFormat(
        type="audio/pcm",
        encoding="s16le",
        sample_rate=sample_rate,
    )


class ByteViewClient:
    def __init__(self, *, lark_profile: str, lark_bin: str = "lark-cli"):
        if not lark_profile:
            raise ValueError("lark_profile is required")
        self.lark_bin = lark_bin
        self.lark_profile = lark_profile
        self.ws = None
        self.session_id = 0
        self._seq_id = 0
        self._send_lock = asyncio.Lock()

    async def _lark_api(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        data: dict | None = None,
    ) -> dict:
        args = [
            self.lark_bin,
            "api",
            method,
            path,
            "--as",
            "bot",
            "--json",
            "--profile",
            self.lark_profile,
        ]
        if params is not None:
            args += ["--params", json.dumps(params)]
        if data is not None:
            args += ["--data", json.dumps(data)]
        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        raw = (stdout or stderr).decode().strip()
        try:
            result = json.loads(raw)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"lark-cli {method} {path} failed: {raw}") from error

        if isinstance(result, dict) and "ok" in result:
            if result.get("ok") is True:
                return {"code": 0, "data": result.get("data") or {}}
            detail = result.get("error") or {}
            return {
                "code": detail.get("code", -1),
                "msg": detail.get("message") or detail.get("type") or "lark-cli error",
            }
        return result

    def _next_seq(self) -> int:
        self._seq_id += 1
        return self._seq_id

    def _encode_event(self, event: meeting_realtime_pb2.ClientEvent) -> bytes:
        frame = frontier_pb2.Frame(
            SeqID=self._next_seq(),
            LogID=0,
            service=FRONTIER_SERVICE,
            method=FRONTIER_METHOD,
            payload_encoding="binary",
            payload_type="application/x-protobuf",
            payload=event.SerializeToString(),
            LogIDNew="",
            msg_id=event.event_id or "",
            frame_type=FRAME_TYPE_NORMAL,
        )
        return frame.SerializeToString()

    @staticmethod
    def _decode_frame(data: bytes):
        frame = frontier_pb2.Frame()
        frame.ParseFromString(data)
        if frame.frame_type in FRAME_TYPES_SKIP or not frame.payload:
            return None
        event = meeting_realtime_pb2.ServerEvent()
        event.ParseFromString(frame.payload)
        return event

    async def _send(self, event: meeting_realtime_pb2.ClientEvent) -> None:
        if self.ws is None:
            raise RuntimeError("ByteView WebSocket is not connected")
        async with self._send_lock:
            await self.ws.send(self._encode_event(event))

    async def join_meeting(self, meeting_no: str) -> str:
        response = await self._lark_api(
            "POST",
            "/open-apis/vc/v1/bots/join",
            data={"join_type": 1, "join_identify": {"meeting_no": meeting_no}},
        )
        if response.get("code") != 0:
            raise RuntimeError(f"bot join failed: {response}")
        meeting_id = response["data"]["meeting"]["id"]
        _log(f"[byteview] joined meeting id={meeting_id}")
        return meeting_id

    async def leave_meeting(self, meeting_id: str) -> None:
        process = await asyncio.create_subprocess_exec(
            self.lark_bin,
            "vc",
            "+meeting-leave",
            "--meeting-id",
            meeting_id,
            "--as",
            "bot",
            "--json",
            "--profile",
            self.lark_profile,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        _log(f"[byteview] leave: {(stdout or stderr).decode().strip()[:200]}")

    async def connect(self, meeting_id: str) -> None:
        response = None
        for attempt in range(1, 5):
            try:
                response = await self._lark_api(
                    "GET",
                    "/open-apis/vc/v1/realtime/endpoint",
                    params={"meeting_id": meeting_id},
                )
                if response.get("code") == 0:
                    break
                _log(f"[byteview] endpoint attempt {attempt} failed: {response}")
            except Exception as error:
                _log(f"[byteview] endpoint attempt {attempt} failed: {error}")
                response = None
            await asyncio.sleep(1)
        if not response or response.get("code") != 0:
            raise RuntimeError(f"get realtime endpoint failed: {response}")

        ws_url = response["data"]["websocket_url"]
        host = urlsplit(ws_url).netloc or "<unknown>"
        _log(f"[byteview] connecting host={host}")
        self.ws = await websockets.connect(ws_url, max_size=10 * 1024 * 1024)

    async def create_session(self, *, sample_rate: int = 24000) -> None:
        audio_format = _audio_format(sample_rate)
        session = meeting_realtime_pb2.Session(
            media=meeting_realtime_pb2.Media(
                audio_upstream_format=audio_format,
                audio_downstream_format=audio_format,
            )
        )
        await self._send(
            meeting_realtime_pb2.ClientEvent(
                type="session.create",
                event_id=str(uuid.uuid4()),
                session_id=0,
                created_at=_now_rfc3339(),
                session_create=meeting_realtime_pb2.SessionCreate(session=session),
            )
        )
        if self.ws is None:
            raise RuntimeError("ByteView WebSocket is not connected")
        async for raw in self.ws:
            event = self._decode_frame(raw)
            if event is None:
                continue
            if event.type == "session.created":
                self.session_id = event.session_id
                _log(f"[byteview] session created id={self.session_id}")
                return
            if event.type == "error":
                raise RuntimeError(f"session create failed: {event.error.message}")

    async def listen(self, on_audio) -> None:
        if self.ws is None:
            raise RuntimeError("ByteView WebSocket is not connected")
        async for raw in self.ws:
            event = self._decode_frame(raw)
            if event is None:
                continue
            if event.type == "audio.downstream.delta":
                audio = event.audio_downstream_delta.delta
                if audio:
                    await on_audio(audio)
            elif event.type == "session.closed":
                _log(f"[byteview] session closed: {event.session_closed.reason}")
                return
            elif event.type == "error":
                _log(
                    f"[byteview] error code={event.error.code}: {event.error.message}"
                )

    async def close(self) -> None:
        if self.ws is not None and self.session_id:
            try:
                await self._send(
                    meeting_realtime_pb2.ClientEvent(
                        type="session.close",
                        event_id=str(uuid.uuid4()),
                        session_id=self.session_id,
                        created_at=_now_rfc3339(),
                        session_close=meeting_realtime_pb2.SessionClose(
                            reason=meeting_realtime_pb2.USER_LEFT
                        ),
                    )
                )
            except Exception:
                pass
        if self.ws is not None:
            await self.ws.close()

