import os from 'node:os';
import path from 'node:path';

export const TARGETS = Object.freeze({
  zayn: Object.freeze({
    app: 'lark-daemon-zayn',
    config: 'ecosystem.config.cjs',
    readyUrl: 'http://127.0.0.1:3738/ready',
    legacyApp: 'lark-daemon',
  }),
  sally: Object.freeze({
    app: 'lark-daemon-sally',
    config: 'ecosystem.config.cjs',
    readyUrl: 'http://127.0.0.1:3740/ready',
  }),
});

export const SHARED_WEB = Object.freeze({
  app: 'lark-web',
  config: 'ecosystem.config.cjs',
  readyUrl: 'http://127.0.0.1:3737/ready',
  legacyApps: Object.freeze(['lark-web-sally']),
});

export const UPGRADE_TARGETS = Object.freeze([...Object.keys(TARGETS), 'all']);

export function getTarget(target) {
  if (typeof target !== 'string' || !Object.hasOwn(TARGETS, target)) {
    throw new Error(`target must be one of: ${UPGRADE_TARGETS.join(', ')}`);
  }
  const spec = TARGETS[target];
  return spec;
}

export function getUpgradeTargets(target) {
  if (target === 'all') return Object.entries(TARGETS);
  return [[target, getTarget(target)]];
}

export function assertUpgradeTarget(target) {
  if (typeof target !== 'string' || !UPGRADE_TARGETS.includes(target)) {
    throw new Error(`target must be one of: ${UPGRADE_TARGETS.join(', ')}`);
  }
  return target;
}

export function defaultSocketPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.local', 'share', 'lark-daemon', 'updater.sock');
}

export function defaultReleaseLink(homeDir = os.homedir()) {
  return path.join(homeDir, '.local', 'lib', 'lark-daemon', 'current');
}
