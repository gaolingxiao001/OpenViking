#!/usr/bin/env node
import { createRequire } from 'node:module';
import { getConfig } from './config.mjs';
import { loginWeixin } from './weixin/auth.mjs';
import { WeixinState } from './weixin/state.mjs';

const require = createRequire(import.meta.url);
const {
  applyDeploymentAgentEnv,
  applyDeploymentDaemonEnv,
  loadDeploymentManifest,
} = require('../../../deployment-config.cjs');

function requestedInstance(argv) {
  if (argv.length === 0) return undefined;
  if (argv.length === 1 && !argv[0].startsWith('-')) return argv[0];
  if (argv.length === 2 && argv[0] === '--instance') return argv[1];
  throw new Error('Usage: npm run weixin:login -- [instance-id]');
}

const instanceId = requestedInstance(process.argv.slice(2));
const deployment = loadDeploymentManifest(process.env);
applyDeploymentDaemonEnv(process.env, deployment);
applyDeploymentAgentEnv(process.env, deployment, instanceId);
const config = getConfig();
if (!config.connectors.includes('weixin')) {
  throw new Error('Selected deployment instance does not configure the weixin connector');
}
const state = new WeixinState(config.dataDir);
try {
  await loginWeixin({ state });
} finally {
  state.close();
}
