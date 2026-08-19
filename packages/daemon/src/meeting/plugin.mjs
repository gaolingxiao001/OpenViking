import { MeetingAdapter } from './adapter.mjs';
import { GenericDecisionAuthority } from './decision-authority.mjs';
import { DecisionAuthorityServer } from './decision-socket.mjs';
import { FlyReferenceRing } from './fly-reference.mjs';
import { MeetingInboxNotifier } from './inbox.mjs';
import { MeetingInputPort } from './input-port.mjs';
import { MeetingAudioCoordinator, MeetingGenerationClock } from './live-coordinator.mjs';
import { LiveSpool } from './live-spool.mjs';
import { MeetingMediaSupervisor } from './media-supervisor.mjs';
import { MeetingRuntimeAdapter } from './runtime-adapter.mjs';
import { StdioMeetingWorkerFactory } from './stdio-worker.mjs';

function insertRuntimeText(runtime, item) {
  if (typeof runtime?.submit !== 'function') {
    return { accepted: false, reason: 'not-attached' };
  }
  return runtime.submit([{
    text: item.text,
    seq: item.seq ?? null,
    receiptId: item.receiptId ?? null,
    scope: item.scope ?? { kind: 'meeting' },
  }]);
}

// Meeting is a standalone inbound plugin: VC events stay in the meeting store,
// and live ASR finals become ordinary text items on the harness submit seam.
export class MeetingPlugin {
  constructor({
    config,
    store,
    lark,
    logger,
    registry,
  }) {
    this.config = config;
    this.store = store;
    this.lark = lark;
    this.logger = logger;
    this.registry = registry;
    this.adapter = null;
    this.inbox = null;
    this.audio = null;
    this.runtime = null;
  }

  async prepare() {
    const audioConfig = this.config.meetingAudio;
    if (audioConfig) {
      const spool = new LiveSpool(audioConfig.spoolPath);
      const generationClock = new MeetingGenerationClock();
      const flyReferences = new FlyReferenceRing({ ttlMs: audioConfig.flyReferenceTtlMs });
      const authority = new GenericDecisionAuthority({
        runtimeToken: this.store.getCognitionState().authorityToken,
        getCurrentGeneration: (sessionEpoch) => generationClock.current(sessionEpoch),
        getLatestLarkSeq: (chatId) => this.store.latestAcceptedInboundSeq(chatId),
        ttlMs: audioConfig.capabilityTtlMs,
      });
      const server = new DecisionAuthorityServer({
        socketPath: audioConfig.authoritySocketPath,
        authority,
        getRuntimeToken: () => this.store.getCognitionState().authorityToken,
        logger: this.logger.child({ component: 'meeting-decision-authority' }),
      });
      await server.start();
      const audio = {
        spool,
        generationClock,
        flyReferences,
        authority,
        server,
        coordinator: null,
        runtime: null,
      };
      const input = new MeetingInputPort({
        spool,
        onReady: () => audio.runtime?.onReady(),
      });
      const workerFactory = new StdioMeetingWorkerFactory({
        command: audioConfig.workerCommand,
        args: audioConfig.workerArgs,
        cwd: audioConfig.workerCwd,
        registry: this.registry,
        logger: this.logger.child({ component: 'meeting-media-worker' }),
        stopTimeoutMs: 15_000,
      });
      let coordinator = null;
      const media = new MeetingMediaSupervisor({
        workerFactory,
        onFinal: (session, event) => input.accept(session, event),
        onUnavailable: (session, reason) => coordinator?.onUnavailable(session, reason),
        onState: (session) => coordinator?.onMediaState(session),
        logger: this.logger.child({ component: 'meeting-media' }),
      });
      coordinator = new MeetingAudioCoordinator({
        media,
        flyReferences,
        authority,
        generationClock,
        mediaEndpointProvider: (meetingId) => this.lark.getMeetingRealtimeEndpoint(meetingId),
        onSessionClosed: (session) => {
          spool.retireSession(session.sessionEpoch);
        },
        sessionCloseGraceMs: audioConfig.capabilityTtlMs * 2,
        logger: this.logger.child({ component: 'meeting-audio' }),
      });
      audio.coordinator = coordinator;
      this.audio = audio;
    }

    this.adapter = new MeetingAdapter({
      store: this.store.meetings,
      lark: this.lark,
      logger: this.logger,
      onInboxReady: (batch) => this.inbox?.signal(batch),
      ...(this.audio ? {
        onJoined: (session) => this.audio.coordinator.onJoined(session),
        onEnding: (event) => this.audio.coordinator.onEnding(event),
        onFlyTranscript: (event) => this.audio.coordinator.observeFlyTranscript(event),
      } : {}),
    });
    return this;
  }

  attachHarness({ runtime, enqueueIngress, flushBufferedIngress }) {
    this.runtime = runtime;
    this.inbox = new MeetingInboxNotifier({
      store: this.store.meetings,
      runtime,
      logger: this.logger.child({ component: 'meeting-inbox' }),
    });
    if (this.audio) {
      this.audio.runtime = new MeetingRuntimeAdapter({
        spool: this.audio.spool,
        generationClock: this.audio.generationClock,
        flyReferences: this.audio.flyReferences,
        runtime,
        insertText: (item) => this.insertText(item),
        submitIngress: enqueueIngress,
        flushBufferedIngress,
        logger: this.logger.child({ component: 'meeting-runtime' }),
      });
    }
    return this;
  }

  insertText(item) {
    return insertRuntimeText(this.runtime, item);
  }

  start() {
    this.audio?.runtime?.start();
    this.inbox?.start();
    return this.adapter?.start() ?? Promise.resolve();
  }

  handleEvent(input) {
    return this.adapter.handleEvent(input);
  }

  onTurnSucceeded(info) {
    this.audio?.runtime?.onTurnSucceeded(info);
  }

  onTurnFailed(info) {
    this.audio?.runtime?.onTurnFailed(info);
  }

  onTurnAbandoned(info) {
    this.audio?.runtime?.onTurnAbandoned(info);
  }

  onAuthorityChanged(token) {
    this.audio?.authority?.setRuntimeToken(token);
  }

  prune() {
    try { this.audio?.spool?.prune(); } catch {}
    try { this.audio?.authority?.prune(); } catch {}
  }

  async stop({ drainIngress } = {}) {
    this.inbox?.stop();
    this.audio?.runtime?.stop();
    if (typeof drainIngress === 'function') {
      try { await drainIngress(); } catch {}
    }
    this.audio?.authority?.revokeAll();
    try { await this.audio?.server?.close(); } catch {}
    try { await this.adapter?.stop(); } catch {}
    try { await this.audio?.coordinator?.stop(); } catch {}
    try { this.audio?.spool?.close(); } catch {}
  }
}
