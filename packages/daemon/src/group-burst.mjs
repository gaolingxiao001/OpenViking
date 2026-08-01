export const GROUP_BURST_DELAY_MS = 400;

// Transport-only batching for warm, idle group traffic. Conversation identity is
// used only to keep a short inbound burst together; Codex still owns one global
// cognitive thread and keeps its existing live turn/steer behavior.
export class GroupBurstRouter {
  constructor({
    deliverBatch,
    tryStartBatch,
    isConnected,
    isTurnInProgress,
    delayMs = GROUP_BURST_DELAY_MS,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (typeof deliverBatch !== 'function') throw new TypeError('deliverBatch must be a function');
    if (typeof tryStartBatch !== 'function') throw new TypeError('tryStartBatch must be a function');
    if (typeof isConnected !== 'function') throw new TypeError('isConnected must be a function');
    if (typeof isTurnInProgress !== 'function') {
      throw new TypeError('isTurnInProgress must be a function');
    }
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new TypeError('delayMs must be a non-negative number');
    }

    this.deliverBatch = deliverBatch;
    this.tryStartBatch = tryStartBatch;
    this.isConnected = isConnected;
    this.isTurnInProgress = isTurnInProgress;
    this.delayMs = delayMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pending = new Map();
    this.nextOrder = 0;
    this.timer = null;
    this.stopped = false;
  }

  get pendingConversations() {
    return this.pending.size;
  }

  route(item) {
    if (this.stopped) return false;
    if (!item || typeof item.conversationKey !== 'string' || !item.conversationKey) {
      throw new TypeError('conversationKey is required');
    }

    let existing = this.pending.get(item.conversationKey);
    if (item.chatType === 'group'
      && existing
      && existing.dueAtMs <= this.now()
      && this.isConnected()
      && !this.isTurnInProgress()) {
      const claimed = this.flushReady();
      existing = this.pending.get(item.conversationKey);
      // An older conversation may have won the idle turn. Keep this expired
      // conversation sealed behind it instead of steering across chat/thread.
      if (claimed && existing) {
        existing.items.push(item);
        return true;
      }
    }
    const immediate = item.chatType !== 'group'
      || !this.isConnected()
      || this.isTurnInProgress();

    if (immediate) {
      if (existing) existing.items.push(item);
      const accepted = this.deliverBatch(existing ? existing.items : [item]) !== false;
      if (accepted && existing) this.pending.delete(item.conversationKey);
      this._schedule();
      return accepted;
    }

    if (existing) {
      existing.items.push(item);
    } else {
      this.pending.set(item.conversationKey, {
        conversationKey: item.conversationKey,
        dueAtMs: this.now() + this.delayMs,
        order: this.nextOrder++,
        items: [item],
      });
    }
    this._schedule();
    return true;
  }

  onAvailable() {
    this.flushReady();
  }

  flushReady() {
    if (this.stopped) return false;
    const currentTime = this.now();
    const next = [...this.pending.values()]
      .filter((entry) => entry.dueAtMs <= currentTime)
      .sort((left, right) => left.dueAtMs - right.dueAtMs || left.order - right.order)[0];
    if (!next) {
      this._schedule();
      return false;
    }

    if (!this.tryStartBatch(next.items)) return false;
    this.pending.delete(next.conversationKey);
    return true;
  }

  // Global slash-command barrier: hand every already-arrived group batch to
  // the current runtime before a /model or /new control action can overtake it.
  flushAll() {
    if (this.stopped || this.pending.size === 0) return 0;
    const entries = [...this.pending.values()]
      .sort((left, right) => left.order - right.order);
    let flushed = 0;
    for (const entry of entries) {
      if (this.deliverBatch(entry.items) === false) break;
      this.pending.delete(entry.conversationKey);
      flushed += 1;
    }
    this._schedule();
    return flushed;
  }

  _schedule() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.stopped || this.pending.size === 0) return;

    const dueAtMs = Math.min(...[...this.pending.values()].map((entry) => entry.dueAtMs));
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flushReady();
    }, Math.max(0, dueAtMs - this.now()));
    this.timer?.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
