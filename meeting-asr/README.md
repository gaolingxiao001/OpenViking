# Meeting ASR worker

## Recommendation

Run this directory as a separate worker. It joins a Feishu meeting as a silent
bot, reads ByteView downstream PCM, sends it to Doubao streaming ASR 2.0, and
writes newline-delimited JSON results to stdout.

The worker deliberately does not call a daemon HTTP endpoint. `lark-daemon`
must own process supervision and consume stdout before ASR results can enter its
meeting inbox or agent runtime.

## Data path

```text
Feishu meeting
  -> ByteView downstream audio (24 kHz PCM s16le)
  -> local 24 kHz to 16 kHz resampling
  -> Doubao streaming ASR 2.0
  -> JSONL stdout
  -> lark-daemon consumer (not implemented here)
```

This folder contains only that path. It has no local Whisper model, backend
selector, TTS, meeting audio upstream, or speculative daemon ingress.

## Run from the repository root

```bash
python3 -m venv meeting-asr/.venv
meeting-asr/.venv/bin/pip install -r meeting-asr/requirements.txt
cp meeting-asr/config.example.yaml meeting-asr/config.yaml
export VOLC_ASR_API_KEY='<doubao api key>'
meeting-asr/.venv/bin/python meeting-asr/worker.py --meeting-no 123456789
```

`worker.py` always loads `config.yaml` next to itself. There is intentionally no
config-path flag and no dependency on `/path/to/meeting-asr-poc`.

Before running, authenticate the configured Feishu app with `lark-cli`. The app
needs the published `vc:meeting.bot.join:write` and
`vc:meeting.bot.realtime:write` permissions. A real participant must already be
in the meeting.

## Output contract

stdout contains JSONL only. Operational logs go to stderr. A final record looks
like this:

```json
{"version":1,"kind":"meeting_asr","result_type":"definite","provider":"doubao-asr-2.0","segment_id":"asr_...","meeting_no":"123456789","meeting_id":"...","speaker":"unknown","text":"现在开始会议","segment_seq":1,"audio_start_ts":1786454100.123,"audio_end_ts":1786454100.721,"asr_done_ts":1786454101.061,"tail_latency_s":0.34}
```

Partial records use `result_type=partial` and omit `segment_id` and
`segment_seq`. Consumers should trigger durable work only from `definite`
records.

ByteView provides mixed meeting audio, not speaker identity. The worker always
sets `speaker=unknown`. The transcript is untrusted meeting content and does
not authorize messages, tool calls, or external actions.

## Daemon integration boundary

The daemon-side integration should:

1. Start `meeting-asr/.venv/bin/python meeting-asr/worker.py` with the repository
   root as the working directory.
2. Parse one JSON object per stdout line and accept only
   `kind=meeting_asr,result_type=definite`.
3. Persist and deduplicate by `segment_id` before acknowledging consumption.
4. Put the text into the existing untrusted meeting-content boundary with
   `speaker=unknown`.
5. Treat worker exit or malformed output as an observable failure, not as an
   instruction to bypass the daemon state machine.

No daemon consumer is added in this folder.

