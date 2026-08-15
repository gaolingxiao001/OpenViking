import { randomUUID } from 'node:crypto';

const ACTIVE_STATES = new Set(['STARTING', 'LIVE']);
const FINAL_STATES = new Set(['LIVE', 'DRAINING']);

function safeSession(value) {
  if (!value?.meetingId || !value?.meetingNumber) {
    throw new Error('meeting media session requires meetingId and meetingNumber');
  }
  if (typeof value.mediaEndpoint !== 'string' || !/^wss:\/\//i.test(value.mediaEndpoint)) {
    throw new Error('meeting media session requires a secure media endpoint');
  }
  return {
    meetingId: String(value.meetingId),
    meetingNumber: String(value.meetingNumber),
    callId: value.callId ? String(value.callId) : null,
    targetChatId: value.targetChatId ? String(value.targetChatId) : null,
    mediaEndpoint: value.mediaEndpoint ? String(value.mediaEndpoint) : null,
  };
}

function snapshot(entry) {
  if (!entry) return null;
  return {
    meetingId: entry.session.meetingId,
    meetingNumber: entry.session.meetingNumber,
    callId: entry.session.callId,
    targetChatId: entry.session.targetChatId,
    sessionEpoch: entry.sessionEpoch,
    captureGeneration: entry.captureGeneration,
    state: entry.state,
  };
}

// Owns only the lifecycle of a media worker. The worker receives an already
// joined meeting binding; it has no ConferencePort and cannot join or leave.
export class MeetingMediaSupervisor {
  constructor({
    workerFactory,
    onFinal,
    onUnavailable = null,
    onState = null,
    logger = null,
    epochFactory = randomUUID,
  }) {
    if (typeof workerFactory?.start !== 'function') {
      throw new TypeError('workerFactory.start is required');
    }
    if (typeof onFinal !== 'function') throw new TypeError('onFinal is required');
    Object.assign(this, {
      workerFactory,
      onFinal,
      onUnavailable,
      onState,
      logger,
      epochFactory,
    });
    this.sessions = new Map();
    this.generations = new Map();
    this.stopped = false;
  }

  state(meetingId) {
    return snapshot(this.sessions.get(meetingId));
  }

  activeSession(meetingId) {
    const entry = this.sessions.get(meetingId);
    return entry && ACTIVE_STATES.has(entry.state) ? snapshot(entry) : null;
  }

  activeSessions() {
    return [...this.sessions.values()]
      .filter((entry) => ACTIVE_STATES.has(entry.state))
      .map(snapshot);
  }

  async start(value) {
    if (this.stopped) throw new Error('meeting media supervisor is stopped');
    const session = safeSession(value);
    const current = this.sessions.get(session.meetingId);
    if (current && ACTIVE_STATES.has(current.state)) return snapshot(current);
    if (current) await this.stop(session.meetingId, 'worker_restart');

    const captureGeneration = (this.generations.get(session.meetingId) ?? 0) + 1;
    this.generations.set(session.meetingId, captureGeneration);
    const entry = {
      session,
      sessionEpoch: this.epochFactory(),
      captureGeneration,
      state: 'STARTING',
      worker: null,
      workerStart: null,
      eventTasks: new Set(),
      stopPromise: null,
      healthCount: 0,
      silentHealthWindows: 0,
    };
    this.sessions.set(session.meetingId, entry);
    this._state(entry);
    try {
      entry.workerStart = this.workerFactory.start({
        ...session,
        sessionEpoch: entry.sessionEpoch,
        captureGeneration,
      }, {
        onEvent: (event) => { this._dispatchEvent(entry, event); },
        onExit: (reason) => { void this._exit(entry, reason); },
      });
      entry.worker = await entry.workerStart;
      return snapshot(entry);
    } catch (error) {
      if (this.sessions.get(session.meetingId) !== entry || entry.state === 'DRAINING') {
        throw error;
      }
      entry.state = 'DEGRADED';
      this._state(entry);
      await this.onUnavailable?.(snapshot(entry), { reason: 'worker_start_failed', error });
      throw error;
    }
  }

  _dispatchEvent(entry, event) {
    const task = this._event(entry, event);
    entry.eventTasks.add(task);
    void task.catch((error) => {
      this.logger?.warn?.('meeting_media_event_failed', { error: error?.message });
    }).finally(() => entry.eventTasks.delete(task));
  }

  async _event(entry, event) {
    if (this.sessions.get(entry.session.meetingId) !== entry) return false;
    if (!event || event.sessionEpoch !== entry.sessionEpoch
      || Number(event.captureGeneration) !== entry.captureGeneration) return false;
    if (event.type === 'partial') return false;
    if (event.type === 'ready'
      || (event.type === 'health' && event.audio === 'healthy' && event.asr === 'healthy')) {
      if (entry.state === 'STARTING') {
        entry.state = 'LIVE';
        this._state(entry);
      }
      if (event.type === 'ready') {
        this.logger?.info?.('meeting_media_ready', {
          captureGeneration: entry.captureGeneration,
        });
      } else {
        this._recordHealth(entry, event);
      }
      return entry.state === 'LIVE';
    }
    if (event.type === 'correction_ignored') {
      const reason = typeof event.reason === 'string'
        ? event.reason.slice(0, 100)
        : 'unspecified';
      const provider = typeof event.asr?.provider === 'string'
        ? event.asr.provider.slice(0, 100)
        : null;
      const rawSequence = event.asr?.result_sequence ?? event.asr?.resultSequence;
      const resultSequence = Number.isSafeInteger(rawSequence) && rawSequence >= 0
        ? rawSequence
        : null;
      this.logger?.debug?.('meeting_media_correction_ignored', {
        reason,
        provider,
        resultSequence,
      });
      return true;
    }
    if (event.type === 'degraded') {
      entry.state = 'DEGRADED';
      this._state(entry);
      const reason = {
        reason: String(event.reason ?? 'worker_degraded'),
      };
      this.logger?.warn?.('meeting_media_degraded', reason);
      // onUnavailable stops the session and waits for all tracked event tasks.
      // Running it inline here makes stop() wait for this same event task,
      // deadlocking the restart path.
      void this._notifyUnavailable(entry, reason);
      return true;
    }
    if (event.type !== 'final' || !FINAL_STATES.has(entry.state)) return false;

    try {
      const result = await this.onFinal(snapshot(entry), event);
      await entry.worker?.ack?.({
        sessionEpoch: entry.sessionEpoch,
        captureGeneration: entry.captureGeneration,
        segmentId: event.segmentId,
        accepted: result?.accepted !== false,
        duplicate: Boolean(result?.duplicate),
        ignored: result?.ignored ?? null,
      });
      return true;
    } catch (error) {
      this.logger?.warn?.('meeting_media_final_failed', { error: error?.message });
      // No ack: a worker with a final WAL retries the same segment id.
      return false;
    }
  }

  async _exit(entry, reason) {
    if (this.sessions.get(entry.session.meetingId) !== entry || entry.state === 'DRAINING') return;
    entry.state = 'DEGRADED';
    this._state(entry);
    await this._notifyUnavailable(entry, {
      reason: 'worker_exit',
      detail: reason ?? null,
    });
  }

  _notifyUnavailable(entry, reason) {
    return Promise.resolve().then(() => this.onUnavailable?.(snapshot(entry), reason)).catch((error) => {
      this.logger?.warn?.('meeting_media_unavailable_failed', { error: error?.message });
      return false;
    });
  }

  _recordHealth(entry, event) {
    entry.healthCount += 1;
    const audioSamples = Number.isSafeInteger(event.audioSamples) && event.audioSamples >= 0
      ? event.audioSamples : null;
    const audioPeak = Number.isFinite(event.audioPeak) && event.audioPeak >= 0
      ? Number(event.audioPeak) : null;
    const audioRms = Number.isFinite(event.audioRms) && event.audioRms >= 0
      ? Number(event.audioRms) : null;
    const audioNonzeroRatio = Number.isFinite(event.audioNonzeroRatio)
      && event.audioNonzeroRatio >= 0 && event.audioNonzeroRatio <= 1
      ? Number(event.audioNonzeroRatio) : null;
    const silent = audioSamples > 0 && audioPeak === 0;
    entry.silentHealthWindows = silent ? entry.silentHealthWindows + 1 : 0;
    const fields = {
      audioSamples,
      audioPeak,
      audioRms,
      audioNonzeroRatio,
      lastAudioAtMs: Number.isFinite(event.lastAudioAtMs) ? Number(event.lastAudioAtMs) : null,
      silentHealthWindows: entry.silentHealthWindows,
    };
    if (entry.healthCount === 1 || entry.healthCount % 6 === 0) {
      this.logger?.info?.('meeting_media_health', fields);
    }
    if (entry.silentHealthWindows === 3 || (entry.silentHealthWindows > 3
      && entry.silentHealthWindows % 6 === 0)) {
      this.logger?.warn?.('meeting_media_audio_silent', fields);
    }
  }

  async stop(meetingId, reason = 'meeting_ended') {
    const entry = this.sessions.get(meetingId);
    if (!entry) return false;
    if (entry.stopPromise) return await entry.stopPromise;
    entry.state = 'DRAINING';
    this._state(entry);
    entry.stopPromise = (async () => {
      try {
        if (!entry.worker && entry.workerStart) {
          try { entry.worker = await entry.workerStart; } catch {}
        }
        await entry.worker?.stop?.({ reason });
        while (entry.eventTasks.size > 0) {
          await Promise.allSettled([...entry.eventTasks]);
        }
      } finally {
        entry.state = 'OFF';
        this._state(entry);
        if (this.sessions.get(meetingId) === entry) this.sessions.delete(meetingId);
      }
      return true;
    })();
    return await entry.stopPromise;
  }

  async stopAll(reason = 'daemon_shutdown') {
    this.stopped = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.stop(id, reason)));
  }

  _state(entry) {
    try { this.onState?.(snapshot(entry)); } catch {}
  }
}
