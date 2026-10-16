# Meeting ASR worker

## Recommendation

Run this directory as a separate worker. It joins a Feishu meeting as a silent
bot, reads ByteView downstream PCM, sends it to Doubao streaming ASR 2.0, and
writes newline-delimited JSON results to stdout.

`worker.py` remains useful as a standalone diagnostic. Production uses
`packages/daemon/worker/meeting_asr_worker.py`: the daemon owns meeting
membership and process supervision, passes the short-lived ByteView endpoint
over stdio, and consumes only fenced, acknowledged final results.

## Data path

```text
Feishu meeting
  -> ByteView downstream audio (24 kHz PCM s16le)
  -> local 24 kHz to 16 kHz resampling
  -> Doubao streaming ASR 2.0
  -> versioned stdio protocol
  -> durable Vika meeting spool
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

## Daemon integration

Set an agent's optional `meetingAudio` manifest field:

```json
"meetingAudio": {
  "targetChatId": "oc_full_private_chat_id",
  "pythonCommand": "/usr/bin/python3",
  "asrConfigFile": "/absolute/private/path/meeting-asr.yaml"
}
```

The config file must be owned by the daemon user with mode `0600`. It may be a
YAML mapping containing `doubao_api_key`, plus any `doubao_*` settings from
`config.example.yaml`. The legacy private `.setup.md` format with an `ASR:`
section is also accepted so a credential does not need to be copied.
