"""Volcengine Doubao streaming ASR 2.0 client.

Implements the optimized bidirectional WebSocket protocol documented at
https://www.volcengine.com/docs/6561/1354869.

The public API is deliberately small:

* :class:`VolcStreamingASRClient` is a long-lived, true streaming session.
  Feed it 16 kHz mono PCM16 as the meeting audio arrives.
* :func:`transcribe_pcm` is a file/segment helper used by smoke tests and the
  legacy ``ASRBackend.transcribe`` interface.

Credentials are only sent in the WebSocket handshake.  They are never put in
request payloads, exceptions, reprs, logs, or returned result objects.
"""

from __future__ import annotations

import asyncio
import gzip
import inspect
import json
import struct
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import websockets

DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration"
DEFAULT_PACKET_MS = 200
PCM_RATE = 16000
PCM_WIDTH = 2
PCM_CHANNELS = 1

_MSG_FULL_CLIENT_REQUEST = 0x1
_MSG_AUDIO_ONLY_REQUEST = 0x2
_MSG_FULL_SERVER_RESPONSE = 0x9
_MSG_SERVER_ACK = 0xB
_MSG_SERVER_ERROR = 0xF

_FLAG_POS_SEQUENCE = 0x1
_FLAG_NEG_WITH_SEQUENCE = 0x3
_SERIALIZATION_RAW = 0x0
_SERIALIZATION_JSON = 0x1
_COMPRESSION_NONE = 0x0
_COMPRESSION_GZIP = 0x1


class VolcAsrError(RuntimeError):
    """A protocol, transport, authentication, or service error."""

    def __init__(self, message: str, *, code: int | None = None,
                 log_id: str = "", request_id: str = ""):
        super().__init__(message)
        self.code = code
        self.log_id = log_id
        self.request_id = request_id


@dataclass(frozen=True)
class ParsedFrame:
    message_type: int
    sequence: int | None = None
    is_last: bool = False
    code: int | None = None
    message: dict | str | bytes | None = None


@dataclass(frozen=True)
class TranscriptEvent:
    """A changed recognition result emitted by the service.

    ``kind`` is ``partial`` for the current mutable utterance and ``final``
    for a second-pass ``definite=true`` utterance.  Final events are emitted
    exactly once per utterance even though server responses are cumulative.
    """

    kind: str
    text: str
    received_at: float
    index: int
    start_ms: int | None = None
    end_ms: int | None = None
    audio_duration_ms: int | None = None
    sequence: int | None = None


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    events: tuple[TranscriptEvent, ...]
    request_id: str
    log_id: str
    connected_ms: float
    first_partial_ms: float | None
    first_final_ms: float | None
    completed_ms: float


def _build_header(message_type: int, flags: int, serialization: int,
                  compression: int) -> bytes:
    return bytes((0x11, (message_type << 4) | flags,
                  (serialization << 4) | compression, 0x00))


def build_full_client_request(sequence: int, request: dict) -> bytes:
    payload = gzip.compress(
        json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode()
    )
    return b"".join((
        _build_header(_MSG_FULL_CLIENT_REQUEST, _FLAG_POS_SEQUENCE,
                      _SERIALIZATION_JSON, _COMPRESSION_GZIP),
        struct.pack(">iI", sequence, len(payload)),
        payload,
    ))


def build_audio_request(sequence: int, audio: bytes, *, last: bool = False) -> bytes:
    if sequence <= 0:
        raise ValueError("audio sequence must be positive before last-frame encoding")
    wire_sequence = -sequence if last else sequence
    flags = _FLAG_NEG_WITH_SEQUENCE if last else _FLAG_POS_SEQUENCE
    payload = gzip.compress(audio)
    # The official Python demo uses JSON + gzip on audio-only headers.  The
    # payload itself remains raw PCM; the server ignores serialization for
    # this message type.  Matching the reference client avoids a protocol
    # compatibility difference between the prose table and the shipped demo.
    return b"".join((
        _build_header(_MSG_AUDIO_ONLY_REQUEST, flags,
                      _SERIALIZATION_JSON, _COMPRESSION_GZIP),
        struct.pack(">iI", wire_sequence, len(payload)),
        payload,
    ))


def parse_response(data: bytes) -> ParsedFrame:
    if len(data) < 4:
        raise VolcAsrError(f"server frame too short: {len(data)}")
    header_size = (data[0] & 0x0F) * 4
    if header_size < 4 or len(data) < header_size:
        raise VolcAsrError("invalid server frame header size")

    message_type = data[1] >> 4
    flags = data[1] & 0x0F
    serialization = data[2] >> 4
    compression = data[2] & 0x0F
    payload = memoryview(data)[header_size:]
    sequence = None

    if flags & 0x01:
        if len(payload) < 4:
            raise VolcAsrError("server frame missing sequence")
        sequence = struct.unpack(">i", payload[:4])[0]
        payload = payload[4:]
    is_last = bool(flags & 0x02)

    code = None
    if message_type == _MSG_FULL_SERVER_RESPONSE:
        if len(payload) < 4:
            raise VolcAsrError("server frame missing payload size")
        size = struct.unpack(">I", payload[:4])[0]
        payload = payload[4:]
    elif message_type == _MSG_SERVER_ACK:
        # Some endpoint versions use ACK frames.  Their payload starts with an
        # acknowledged sequence, followed by an optional payload size.
        if len(payload) < 4:
            return ParsedFrame(message_type, sequence, is_last)
        sequence = struct.unpack(">i", payload[:4])[0]
        payload = payload[4:]
        if len(payload) < 4:
            return ParsedFrame(message_type, sequence, is_last)
        size = struct.unpack(">I", payload[:4])[0]
        payload = payload[4:]
    elif message_type == _MSG_SERVER_ERROR:
        if len(payload) < 8:
            raise VolcAsrError("server error frame missing code or size")
        code, size = struct.unpack(">II", payload[:8])
        payload = payload[8:]
    else:
        return ParsedFrame(message_type, sequence, is_last, message=bytes(payload))

    if size > len(payload):
        raise VolcAsrError(
            f"server frame payload truncated: declared {size}, got {len(payload)}"
        )
    decoded = bytes(payload[:size])
    if compression == _COMPRESSION_GZIP and decoded:
        try:
            decoded = gzip.decompress(decoded)
        except (OSError, EOFError) as error:
            raise VolcAsrError("invalid gzip payload from ASR service") from error

    message: dict | str | bytes | None = None
    if decoded:
        if serialization == _SERIALIZATION_JSON:
            try:
                message = json.loads(decoded)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise VolcAsrError("invalid JSON payload from ASR service") from error
        elif serialization == _SERIALIZATION_RAW:
            message = decoded
        else:
            message = decoded
    return ParsedFrame(message_type, sequence, is_last, code, message)


def default_request(*, uid: str, enable_nonstream: bool = True,
                    end_window_size: int = 500, enable_ddc: bool = False,
                    hotwords: tuple[str, ...] = ()) -> dict:
    if end_window_size < 200:
        raise ValueError("end_window_size must be at least 200ms")
    request: dict = {
        "model_name": "bigmodel",
        "enable_itn": True,
        "enable_punc": True,
        "enable_ddc": enable_ddc,
        "show_utterances": True,
        "enable_nonstream": enable_nonstream,
        "end_window_size": end_window_size,
        "result_type": "full",
    }
    clean_hotwords = [word.strip() for word in hotwords if word.strip()]
    if clean_hotwords:
        request["corpus"] = {
            "context": json.dumps(
                {"hotwords": [{"word": word} for word in clean_hotwords]},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        }
    return {
        "user": {"uid": uid},
        "audio": {
            "format": "pcm",
            "codec": "raw",
            "rate": PCM_RATE,
            "bits": 16,
            "channel": PCM_CHANNELS,
        },
        "request": request,
    }


ResultCallback = Callable[[TranscriptEvent], Awaitable[None] | None]


class VolcStreamingASRClient:
    """One long-lived optimized bidirectional ASR session."""

    def __init__(self, api_key: str, *, endpoint: str = DEFAULT_ENDPOINT,
                 resource_id: str = DEFAULT_RESOURCE_ID,
                 packet_ms: int = DEFAULT_PACKET_MS,
                 end_window_size: int = 500,
                 enable_nonstream: bool = True,
                 enable_ddc: bool = False,
                 hotwords: tuple[str, ...] = (),
                 connect_timeout: float = 10,
                 finish_timeout: float = 10):
        if not api_key:
            raise ValueError("Volcengine API key is required")
        if packet_ms < 50 or packet_ms > 1000:
            raise ValueError("packet_ms must be in 50..1000")
        self._api_key = api_key
        self.endpoint = endpoint
        self.resource_id = resource_id
        self.packet_ms = packet_ms
        self.end_window_size = end_window_size
        self.enable_nonstream = enable_nonstream
        self.enable_ddc = enable_ddc
        self.hotwords = tuple(hotwords)
        self.connect_timeout = connect_timeout
        self.finish_timeout = finish_timeout

        self.request_id = ""
        self.log_id = ""
        self.connected_at: float | None = None
        self.audio_origin_at: float | None = None
        self.audio_bytes_sent = 0
        self._sequence = 1
        self._buffer = bytearray()
        self._ws = None
        self._receiver_task: asyncio.Task | None = None
        self._last_received = asyncio.Event()
        self._closed = False
        self._callback: ResultCallback | None = None
        self._definite_count = 0
        self._last_partial = ""
        self._events: list[TranscriptEvent] = []
        self._terminal_error: VolcAsrError | None = None

    @property
    def packet_bytes(self) -> int:
        return PCM_RATE * PCM_WIDTH * PCM_CHANNELS * self.packet_ms // 1000

    @property
    def events(self) -> tuple[TranscriptEvent, ...]:
        return tuple(self._events)

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(endpoint={self.endpoint!r}, "
            f"resource_id={self.resource_id!r}, packet_ms={self.packet_ms})"
        )

    async def start(self, callback: ResultCallback | None = None) -> None:
        if self._ws is not None:
            raise RuntimeError("ASR session already started")
        self._callback = callback
        self.request_id = str(uuid.uuid4())
        headers = {
            "X-Api-Key": self._api_key,
            "X-Api-Resource-Id": self.resource_id,
            "X-Api-Request-Id": self.request_id,
            "X-Api-Connect-Id": self.request_id,
            "X-Api-Sequence": "-1",
        }
        try:
            self._ws = await websockets.connect(
                self.endpoint,
                additional_headers=headers,
                open_timeout=self.connect_timeout,
                close_timeout=3,
                ping_interval=20,
                ping_timeout=20,
                max_size=8 * 1024 * 1024,
            )
            self.connected_at = time.time()
            response = getattr(self._ws, "response", None)
            if response is not None:
                self.log_id = response.headers.get("X-Tt-Logid", "")

            request = default_request(
                uid=f"meeting-asr-{self.request_id}",
                enable_nonstream=self.enable_nonstream,
                end_window_size=self.end_window_size,
                enable_ddc=self.enable_ddc,
                hotwords=self.hotwords,
            )
            await self._ws.send(build_full_client_request(self._sequence, request))
            self._sequence += 1

            # The reference demo waits for the full-client response before
            # sending audio.  This turns entitlement/config failures into a
            # deterministic start error rather than an asynchronous surprise.
            first_raw = await asyncio.wait_for(self._ws.recv(), timeout=5)
            if not isinstance(first_raw, bytes):
                raise VolcAsrError("ASR service returned a non-binary frame")
            first = parse_response(first_raw)
            self._raise_server_error(first)
            await self._handle_frame(first)
            self._receiver_task = asyncio.create_task(
                self._receive_loop(), name="volc-asr-receiver"
            )
        except Exception as error:
            await self._close_transport()
            if isinstance(error, VolcAsrError):
                raise
            raise VolcAsrError(
                f"failed to start Volcengine ASR: {type(error).__name__}",
                log_id=self.log_id,
                request_id=self.request_id,
            ) from error

    async def feed_pcm(self, pcm16k: bytes) -> int:
        """Feed live PCM and send complete 200 ms protocol packets.

        ByteView already delivers audio in real time, so this method never
        sleeps.  It only coalesces incoming frames to the documented packet
        size.  Returns the number of protocol packets sent.
        """
        self._ensure_running()
        if len(pcm16k) % 2:
            raise ValueError("PCM16 byte length must be even")
        if pcm16k and self.audio_origin_at is None:
            self.audio_origin_at = time.time()
        self._buffer.extend(pcm16k)
        sent = 0
        while len(self._buffer) >= self.packet_bytes:
            packet = bytes(self._buffer[:self.packet_bytes])
            del self._buffer[:self.packet_bytes]
            await self._send_audio_packet(packet, last=False)
            sent += 1
        return sent

    async def finish(self) -> tuple[TranscriptEvent, ...]:
        """Flush buffered audio, send the negative packet, and await final result."""
        if self._closed:
            return self.events
        self._ensure_running()
        try:
            # Empty negative packets are explicitly supported by the official
            # helper and keep the live path from withholding 200 ms of audio.
            final_audio = bytes(self._buffer)
            self._buffer.clear()
            await self._send_audio_packet(final_audio, last=True)
            await asyncio.wait_for(self._last_received.wait(), self.finish_timeout)
            if self._receiver_task is not None:
                await asyncio.wait_for(self._receiver_task, timeout=2)
            if self._terminal_error is not None:
                raise self._terminal_error
            return self.events
        except asyncio.TimeoutError as error:
            raise VolcAsrError(
                "timed out waiting for final Volcengine ASR result",
                log_id=self.log_id,
                request_id=self.request_id,
            ) from error
        finally:
            await self._close_transport()

    async def abort(self) -> None:
        await self._close_transport()

    async def _send_audio_packet(self, packet: bytes, *, last: bool) -> None:
        self._ensure_running()
        assert self._ws is not None
        sequence = self._sequence
        try:
            await self._ws.send(build_audio_request(sequence, packet, last=last))
        except Exception as error:
            raise VolcAsrError(
                f"Volcengine ASR send failed: {type(error).__name__}",
                log_id=self.log_id,
                request_id=self.request_id,
            ) from error
        self._sequence += 1
        self.audio_bytes_sent += len(packet)

    async def _receive_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                if not isinstance(raw, bytes):
                    continue
                frame = parse_response(raw)
                self._raise_server_error(frame)
                await self._handle_frame(frame)
                if frame.is_last:
                    self._last_received.set()
                    return
            if not self._last_received.is_set():
                self._terminal_error = VolcAsrError(
                    "Volcengine ASR connection closed before final result",
                    log_id=self.log_id,
                    request_id=self.request_id,
                )
                self._last_received.set()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if isinstance(error, VolcAsrError):
                self._terminal_error = error
            else:
                self._terminal_error = VolcAsrError(
                    f"Volcengine ASR receive failed: {type(error).__name__}",
                    log_id=self.log_id,
                    request_id=self.request_id,
                )
            self._last_received.set()

    def _raise_server_error(self, frame: ParsedFrame) -> None:
        if frame.message_type != _MSG_SERVER_ERROR:
            return
        detail = ""
        if isinstance(frame.message, dict):
            detail = str(frame.message.get("error") or frame.message.get("message") or "")
        elif isinstance(frame.message, bytes):
            detail = frame.message.decode("utf-8", "replace")
        elif frame.message:
            detail = str(frame.message)
        suffix = f": {detail}" if detail else ""
        raise VolcAsrError(
            f"Volcengine ASR rejected request (code={frame.code}){suffix}",
            code=frame.code,
            log_id=self.log_id,
            request_id=self.request_id,
        )

    async def _handle_frame(self, frame: ParsedFrame) -> None:
        if frame.message_type != _MSG_FULL_SERVER_RESPONSE:
            return
        if not isinstance(frame.message, dict):
            return
        result = frame.message.get("result") or {}
        utterances = result.get("utterances") or []
        audio_info = frame.message.get("audio_info") or {}
        duration = audio_info.get("duration")
        definite = [item for item in utterances if item.get("definite")]
        for index in range(self._definite_count, len(definite)):
            item = definite[index]
            event = TranscriptEvent(
                kind="final",
                text=str(item.get("text") or "").strip(),
                received_at=time.time(),
                index=index + 1,
                start_ms=_optional_int(item.get("start_time")),
                end_ms=_optional_int(item.get("end_time")),
                audio_duration_ms=_optional_int(duration),
                sequence=frame.sequence,
            )
            if event.text:
                await self._emit(event)
        self._definite_count = len(definite)

        if len(utterances) > len(definite):
            active = utterances[-1]
            text = str(active.get("text") or "").strip()
            if text and text != self._last_partial:
                self._last_partial = text
                await self._emit(TranscriptEvent(
                    kind="partial",
                    text=text,
                    received_at=time.time(),
                    index=len(utterances),
                    start_ms=_optional_int(active.get("start_time")),
                    end_ms=_optional_int(active.get("end_time")),
                    audio_duration_ms=_optional_int(duration),
                    sequence=frame.sequence,
                ))

        # Some final endpoint responses omit utterances.  Preserve the full
        # text as a final fallback so a valid transcript isn't lost.
        if frame.is_last and not self._definite_count:
            text = str(result.get("text") or "").strip()
            if text:
                await self._emit(TranscriptEvent(
                    kind="final",
                    text=text,
                    received_at=time.time(),
                    index=1,
                    audio_duration_ms=_optional_int(duration),
                    sequence=frame.sequence,
                ))

    async def _emit(self, event: TranscriptEvent) -> None:
        self._events.append(event)
        if self._callback is None:
            return
        result = self._callback(event)
        if inspect.isawaitable(result):
            await result

    def _ensure_running(self) -> None:
        if self._ws is None or self._closed:
            raise RuntimeError("ASR session is not running")
        if self._terminal_error is not None:
            raise self._terminal_error

    async def _close_transport(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._receiver_task is not None and not self._receiver_task.done():
            self._receiver_task.cancel()
            await asyncio.gather(self._receiver_task, return_exceptions=True)
        if self._ws is not None:
            await self._ws.close()


async def transcribe_pcm(pcm16k: bytes, *, api_key: str,
                         endpoint: str = DEFAULT_ENDPOINT,
                         resource_id: str = DEFAULT_RESOURCE_ID,
                         packet_ms: int = DEFAULT_PACKET_MS,
                         end_window_size: int = 500,
                         enable_nonstream: bool = True,
                         enable_ddc: bool = False,
                         pace_realtime: bool = True,
                         hotwords: tuple[str, ...] = ()) -> TranscriptionResult:
    """Transcribe complete PCM through the same streaming protocol.

    ``pace_realtime=True`` follows the official 200 ms send cadence and is the
    only meaningful mode for latency measurements.  ``False`` is useful for a
    quick compatibility smoke test, but its timing must not be reported as
    live-stream latency.
    """
    if not pcm16k:
        raise ValueError("cannot transcribe empty PCM")
    started = time.time()
    client = VolcStreamingASRClient(
        api_key,
        endpoint=endpoint,
        resource_id=resource_id,
        packet_ms=packet_ms,
        end_window_size=end_window_size,
        enable_nonstream=enable_nonstream,
        enable_ddc=enable_ddc,
        hotwords=hotwords,
    )
    try:
        await client.start()
        connected_at = time.time()
        packet_bytes = client.packet_bytes
        for offset in range(0, len(pcm16k), packet_bytes):
            await client.feed_pcm(pcm16k[offset:offset + packet_bytes])
            if pace_realtime and offset + packet_bytes < len(pcm16k):
                await asyncio.sleep(packet_ms / 1000)
        await client.finish()
    except Exception:
        await client.abort()
        raise
    completed = time.time()
    events = client.events
    finals = [event.text for event in events if event.kind == "final"]
    text = "".join(finals).strip()
    if not text:
        partials = [event.text for event in events if event.kind == "partial"]
        text = partials[-1] if partials else ""

    first_partial = next((event.received_at for event in events
                          if event.kind == "partial"), None)
    first_final = next((event.received_at for event in events
                        if event.kind == "final"), None)
    return TranscriptionResult(
        text=text,
        events=events,
        request_id=client.request_id,
        log_id=client.log_id,
        connected_ms=round((connected_at - started) * 1000, 1),
        first_partial_ms=(round((first_partial - connected_at) * 1000, 1)
                          if first_partial is not None else None),
        first_final_ms=(round((first_final - connected_at) * 1000, 1)
                        if first_final is not None else None),
        completed_ms=round((completed - connected_at) * 1000, 1),
    )


def _optional_int(value) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
