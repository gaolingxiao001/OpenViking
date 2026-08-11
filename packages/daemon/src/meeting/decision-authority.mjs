import { randomBytes } from 'node:crypto';

export const DEFAULT_DECISION_TTL_MS = 30_000;
export const MAX_DECISION_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_REVOKED_SESSION_TTL_MS = MAX_DECISION_TTL_MS;

function scalar(value, label) {
  if (typeof value === 'string') {
    if (!value || value.length > 1_024) {
      throw new TypeError(`${label} must contain 1-1024 characters`);
    }
    return value;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'bigint' && value >= 0n) return value;
  throw new TypeError(`${label} must be a non-empty string or non-negative integer`);
}

function text(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new TypeError(`${label} must contain 1-2048 characters`);
  }
  return value;
}

function seq(value, label = 'larkFenceSeq') {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function optionalSeq(value, label = 'larkFenceSeq') {
  return value === undefined || value === null ? null : seq(value, label);
}

function ttl(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_DECISION_TTL_MS) {
    throw new TypeError(`ttlMs must be between 1 and ${MAX_DECISION_TTL_MS}`);
  }
  return value;
}

function encodedScalar(value) {
  return `${typeof value}:${String(value).length}:${String(value)}`;
}

function scopeKey(sessionEpoch, generation, decisionKey) {
  return [sessionEpoch, generation].map(encodedScalar).join('|') + `|${decisionKey.length}:${decisionKey}`;
}

function exact(left, right) {
  return typeof left === typeof right && left === right;
}

export class GenericDecisionAuthority {
  constructor({
    runtimeToken = null,
    getCurrentGeneration = () => null,
    getLatestLarkSeq = () => null,
    ttlMs = DEFAULT_DECISION_TTL_MS,
    revokedSessionTtlMs = DEFAULT_REVOKED_SESSION_TTL_MS,
    now = Date.now,
  } = {}) {
    if (typeof getCurrentGeneration !== 'function') {
      throw new TypeError('getCurrentGeneration must be a function');
    }
    if (typeof getLatestLarkSeq !== 'function') {
      throw new TypeError('getLatestLarkSeq must be a function');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.getCurrentGeneration = getCurrentGeneration;
    this.getLatestLarkSeq = getLatestLarkSeq;
    this.defaultTtlMs = ttl(ttlMs);
    this.revokedSessionTtlMs = ttl(revokedSessionTtlMs);
    this.now = now;
    this.runtimeToken = null;
    this.capabilities = new Map();
    this.byScope = new Map();
    this.claimedScopes = new Set();
    // A tombstone prevents any late path from minting fresh authority for an
    // ended worker epoch. It only needs to outlive the longest capability;
    // pruning on authority activity bounds this map to recently ended epochs.
    this.revokedSessions = new Map();
    if (runtimeToken !== null && runtimeToken !== undefined) this.setRuntimeToken(runtimeToken);
  }

  _sessionKey(sessionEpoch) {
    return encodedScalar(sessionEpoch);
  }

  setRuntimeToken(runtimeToken) {
    const safeToken = text(runtimeToken, 'runtimeToken');
    if (this.runtimeToken === safeToken) return 0;
    const revoked = this.revokeAll();
    this.runtimeToken = safeToken;
    return revoked;
  }

  issue({
    sessionEpoch,
    generation,
    decisionKey,
    action,
    target,
    larkFenceSeq,
    ttlMs = this.defaultTtlMs,
  }) {
    const safeSessionEpoch = scalar(sessionEpoch, 'sessionEpoch');
    const safeGeneration = scalar(generation, 'generation');
    const safeDecisionKey = text(decisionKey, 'decisionKey');
    const safeAction = text(action, 'action');
    const safeTarget = text(target, 'target');
    const safeFence = optionalSeq(larkFenceSeq);
    const safeTtl = ttl(ttlMs);
    if (!this.runtimeToken) throw new Error('decision authority has no active runtime token');
    const atMs = this.now();
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new TypeError('now must return milliseconds');
    this.prune({ atMs });
    if (this.revokedSessions.has(this._sessionKey(safeSessionEpoch))) {
      throw new Error('decision session has been revoked');
    }

    const key = scopeKey(safeSessionEpoch, safeGeneration, safeDecisionKey);
    if (this.claimedScopes.has(key)) throw new Error('decision was already claimed');
    const existingCapability = this.byScope.get(key);
    const existing = existingCapability
      ? this.capabilities.get(existingCapability)
      : null;
    if (existing) {
      if (
        existing.action !== safeAction
        || existing.target !== safeTarget
        || existing.larkFenceSeq !== safeFence
        || existing.runtimeToken !== this.runtimeToken
      ) {
        throw new Error('decisionKey is already bound to a different decision');
      }
      return {
        capability: existing.capability,
        decisionKey: existing.decisionKey,
        expiresAtMs: existing.expiresAtMs,
      };
    }

    const capability = `decision_${randomBytes(32).toString('base64url')}`;
    const record = {
      capability,
      sessionEpoch: safeSessionEpoch,
      generation: safeGeneration,
      decisionKey: safeDecisionKey,
      action: safeAction,
      target: safeTarget,
      larkFenceSeq: safeFence,
      runtimeToken: this.runtimeToken,
      issuedAtMs: atMs,
      expiresAtMs: atMs + safeTtl,
      claimedAtMs: null,
      scopeKey: key,
    };
    this.capabilities.set(capability, record);
    this.byScope.set(key, capability);
    return { capability, decisionKey: safeDecisionKey, expiresAtMs: record.expiresAtMs };
  }

  claim(capability, { runtimeToken, action, target }) {
    const safeCapability = text(capability, 'capability');
    const safeRuntimeToken = text(runtimeToken, 'runtimeToken');
    const safeAction = text(action, 'action');
    const safeTarget = text(target, 'target');
    const record = this.capabilities.get(safeCapability);
    if (!record) throw new Error('decision capability is unknown or revoked');
    if (record.claimedAtMs !== null || this.claimedScopes.has(record.scopeKey)) {
      throw new Error('decision capability was already claimed');
    }
    const atMs = this.now();
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new TypeError('now must return milliseconds');
    if (atMs >= record.expiresAtMs) {
      this._remove(record);
      throw new Error('decision capability expired');
    }
    this._pruneRevokedSessions(atMs);
    if (
      safeRuntimeToken !== record.runtimeToken
      || safeRuntimeToken !== this.runtimeToken
    ) {
      throw new Error('decision runtime token is no longer active');
    }
    if (safeAction !== record.action || safeTarget !== record.target) {
      throw new Error('decision capability does not authorize this exact action and target');
    }
    if (this.revokedSessions.has(this._sessionKey(record.sessionEpoch))) {
      throw new Error('decision session has been revoked');
    }

    let currentGeneration;
    try {
      currentGeneration = this.getCurrentGeneration(record.sessionEpoch);
    } catch {
      throw new Error('decision freshness could not be verified');
    }
    if (!exact(currentGeneration, record.generation)) {
      throw new Error('decision generation is stale');
    }
    if (record.larkFenceSeq !== null) {
      let latestLarkSeq;
      try {
        latestLarkSeq = seq(this.getLatestLarkSeq(record.target), 'latest Lark seq');
      } catch {
        throw new Error('decision freshness could not be verified');
      }
      if (latestLarkSeq !== record.larkFenceSeq) {
        throw new Error('decision Lark freshness fence is stale');
      }
    }

    // Claim before handing authority to the caller. A failed or uncertain
    // downstream side effect must not make the same capability reusable.
    record.claimedAtMs = atMs;
    this.claimedScopes.add(record.scopeKey);
    return {
      decisionKey: record.decisionKey,
      sessionEpoch: record.sessionEpoch,
      generation: record.generation,
      action: record.action,
      target: record.target,
      larkFenceSeq: record.larkFenceSeq,
      claimedAtMs: atMs,
    };
  }

  _remove(record) {
    this.capabilities.delete(record.capability);
    if (this.byScope.get(record.scopeKey) === record.capability) {
      this.byScope.delete(record.scopeKey);
    }
  }

  revokeDecision(sessionEpoch, generation, decisionKey) {
    const safeSessionEpoch = scalar(sessionEpoch, 'sessionEpoch');
    const safeGeneration = scalar(generation, 'generation');
    const safeDecisionKey = text(decisionKey, 'decisionKey');
    const key = scopeKey(safeSessionEpoch, safeGeneration, safeDecisionKey);
    const capability = this.byScope.get(key);
    const record = capability ? this.capabilities.get(capability) : null;
    if (!record) return false;
    this._remove(record);
    // A claimed decision stays fenced. This method exists for unspent
    // capabilities abandoned with a failed turn, which may be issued again.
    return true;
  }

  decisionStatus(sessionEpoch, generation, decisionKey) {
    const safeSessionEpoch = scalar(sessionEpoch, 'sessionEpoch');
    const safeGeneration = scalar(generation, 'generation');
    const safeDecisionKey = text(decisionKey, 'decisionKey');
    const key = scopeKey(safeSessionEpoch, safeGeneration, safeDecisionKey);
    if (this.claimedScopes.has(key)) return 'claimed';
    const capability = this.byScope.get(key);
    return capability && this.capabilities.has(capability) ? 'active' : 'missing';
  }

  revokeSession(sessionEpoch) {
    const safeSessionEpoch = scalar(sessionEpoch, 'sessionEpoch');
    const sessionKey = this._sessionKey(safeSessionEpoch);
    const atMs = this.now();
    if (!Number.isSafeInteger(atMs) || atMs < 0) throw new TypeError('now must return milliseconds');
    this._pruneRevokedSessions(atMs);
    this.revokedSessions.set(sessionKey, atMs + this.revokedSessionTtlMs);
    let revoked = 0;
    for (const record of [...this.capabilities.values()]) {
      if (!exact(record.sessionEpoch, safeSessionEpoch)) continue;
      this._remove(record);
      this.claimedScopes.delete(record.scopeKey);
      revoked += 1;
    }
    const prefix = `${encodedScalar(safeSessionEpoch)}|`;
    for (const key of this.claimedScopes) {
      if (key.startsWith(prefix)) this.claimedScopes.delete(key);
    }
    return revoked;
  }

  revokeAll() {
    const revoked = this.capabilities.size;
    this.capabilities.clear();
    this.byScope.clear();
    // Rotation opens a new authority generation. Keeping claim markers here
    // would prevent the replacement runtime from deliberately re-issuing a
    // stable decisionKey; downstream receives that key for durable dedupe.
    this.claimedScopes.clear();
    return revoked;
  }

  prune({ atMs = this.now() } = {}) {
    if (!Number.isSafeInteger(atMs) || atMs < 0) {
      throw new TypeError('atMs must be a non-negative millisecond timestamp');
    }
    let removed = 0;
    for (const record of [...this.capabilities.values()]) {
      if (record.expiresAtMs > atMs) continue;
      this._remove(record);
      // Claimed scopes remain fenced for the lifetime of the active runtime or
      // session, even after their capability record is pruned.
      removed += 1;
    }
    removed += this._pruneRevokedSessions(atMs);
    return removed;
  }

  _pruneRevokedSessions(atMs) {
    let removed = 0;
    for (const [sessionKey, expiresAtMs] of this.revokedSessions) {
      if (expiresAtMs > atMs) continue;
      this.revokedSessions.delete(sessionKey);
      removed += 1;
    }
    return removed;
  }

  stats() {
    let active = 0;
    let claimed = 0;
    for (const record of this.capabilities.values()) {
      if (record.claimedAtMs === null) active += 1;
      else claimed += 1;
    }
    return {
      active,
      claimed,
      capabilities: active + claimed,
      claimedDecisions: this.claimedScopes.size,
      revokedSessions: this.revokedSessions.size,
      runtimeActive: Boolean(this.runtimeToken),
    };
  }
}
