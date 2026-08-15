import { spawn as nodeSpawn } from 'node:child_process';
import { terminateProcessTree } from '../process-utils.mjs';

const MAX_LINE_BYTES = 16 * 1024;

function workerEnv(environment) {
  const allowed = new Set([
    'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  ]);
  const safe = {};
  for (const key of allowed) {
    if (typeof environment[key] === 'string') safe[key] = environment[key];
  }
  Object.assign(safe, { PYTHONUNBUFFERED: '1', FORCE_COLOR: '0', NO_COLOR: '1' });
  return safe;
}

function commandLine(value) {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    throw new Error('meeting worker command exceeds 16 KiB');
  }
  return line;
}

function normalizeEvent(value) {
  const type = value?.type === 'transcript.final' ? 'final' : value?.type;
  return {
    type,
    sessionEpoch: value?.session_epoch,
    captureGeneration: value?.capture_generation,
    segmentId: value?.event_id ?? value?.segment_id,
    segmentSeq: value?.segment_seq ?? value?.seq,
    text: value?.text,
    audioStartMs: value?.audio_start_ms
      ?? (Number.isFinite(value?.audio_start_ts) ? value.audio_start_ts * 1_000 : null),
    audioEndMs: value?.audio_end_ms
      ?? (Number.isFinite(value?.audio_end_ts) ? value.audio_end_ts * 1_000 : null),
    audio: value?.audio,
    asr: value?.asr,
    reason: value?.reason,
    lastAudioAtMs: value?.last_audio_at_ms,
    audioSamples: value?.audio_samples,
    audioPeak: value?.audio_peak,
    audioRms: value?.audio_rms,
    audioNonzeroRatio: value?.audio_nonzero_ratio,
  };
}

export class StdioMeetingWorkerFactory {
  constructor({
    command,
    args = [],
    cwd = process.cwd(),
    env = process.env,
    registry = null,
    logger = null,
    spawn = nodeSpawn,
    stopTimeoutMs = 3_000,
  }) {
    if (typeof command !== 'string' || !command) throw new TypeError('worker command is required');
    Object.assign(this, {
      command,
      args,
      cwd,
      env,
      registry,
      logger,
      spawn,
      stopTimeoutMs,
    });
  }

  async start(session, { onEvent, onExit }) {
    const child = this.spawn(this.command, this.args, {
      cwd: this.cwd,
      env: workerEnv(this.env),
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.registry?.register?.(child);
    child.stdin?.on('error', () => {});
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let stopping = false;
    let exited = false;
    let resolveExit;
    const exit = new Promise((resolve) => { resolveExit = resolve; });
    const send = (value) => {
      if (exited || !child.stdin?.writable) throw new Error('meeting worker stdin is closed');
      child.stdin.write(commandLine(value));
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > MAX_LINE_BYTES * 2) {
        terminateProcessTree(child, 'SIGKILL');
        return;
      }
      while (true) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (value?.v !== 1) throw new Error('unsupported worker protocol version');
          void onEvent(normalizeEvent(value));
        } catch (error) {
          this.logger?.warn?.('meeting_worker_protocol_error', { error: error?.message });
          terminateProcessTree(child, 'SIGKILL');
        }
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    child.once('error', (error) => {
      if (!exited) {
        this.logger?.warn?.('meeting_worker_spawn_error', { error });
        void onExit({ reason: 'spawn_error', error: error.message });
      }
    });
    child.once('exit', (code, signal) => {
      exited = true;
      resolveExit({ code, signal });
      if (!stopping) {
        const detail = stderr.trim();
        this.logger?.warn?.('meeting_worker_exited', {
          code,
          signal,
          stderr: detail || undefined,
          stderrBytes: Buffer.byteLength(stderr),
        });
        void onExit({
          reason: 'process_exit',
          code,
          signal,
          stderrBytes: Buffer.byteLength(stderr),
        });
      } else if (stderr.trim()) {
        this.logger?.debug?.('meeting_worker_stderr', { bytes: Buffer.byteLength(stderr) });
      }
    });

    send({
      v: 1,
      command: 'start',
      command_id: `start_${session.sessionEpoch}`,
      session_id: session.sessionEpoch,
      session_epoch: session.sessionEpoch,
      capture_generation: session.captureGeneration,
      meeting_id: session.meetingId,
      meeting_no: session.meetingNumber,
      ...(session.mediaEndpoint ? { media_endpoint: session.mediaEndpoint } : {}),
    });

    return {
      ack: async ({ sessionEpoch, captureGeneration, segmentId }) => {
        send({
          v: 1,
          command: 'ack',
          command_id: `ack_${segmentId}`,
          session_id: sessionEpoch,
          session_epoch: sessionEpoch,
          capture_generation: captureGeneration,
          event_id: segmentId,
        });
      },
      stop: async ({ reason }) => {
        if (exited) return;
        stopping = true;
        try {
          send({
            v: 1,
            command: 'stop',
            command_id: `stop_${session.sessionEpoch}`,
            session_id: session.sessionEpoch,
            session_epoch: session.sessionEpoch,
            reason,
          });
        } catch {}
        let timer;
        await Promise.race([
          exit,
          new Promise((resolve) => {
            timer = setTimeout(resolve, this.stopTimeoutMs);
            timer.unref?.();
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (!exited) terminateProcessTree(child, 'SIGTERM');
      },
    };
  }
}
