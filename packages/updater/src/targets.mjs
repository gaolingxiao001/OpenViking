import os from 'node:os';
import path from 'node:path';

export const TARGETS = Object.freeze({
  zayn: Object.freeze({
    app: 'lark-daemon',
    config: 'ecosystem.config.cjs',
    readyUrl: 'http://127.0.0.1:3738/ready',
  }),
  sally: Object.freeze({
    app: 'lark-daemon-sally',
    config: 'ecosystem.sally.config.cjs',
    readyUrl: 'http://127.0.0.1:3740/ready',
  }),
});

export function getTarget(target) {
  if (typeof target !== 'string' || !Object.hasOwn(TARGETS, target)) {
    throw new Error(`target must be one of: ${Object.keys(TARGETS).join(', ')}`);
  }
  const spec = TARGETS[target];
  return spec;
}

export function defaultSocketPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.local', 'share', 'lark-daemon', 'updater.sock');
}

export function defaultReleaseLink(homeDir = os.homedir()) {
  return path.join(homeDir, '.local', 'lib', 'lark-daemon', 'current');
}
