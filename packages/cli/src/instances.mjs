import fs from 'node:fs';
import { createRequire } from 'node:module';

// Which instance a command means, when the user did not say or does not
// remember: the only one, or a choice that shows each instance's IMs.

const require = createRequire(import.meta.url);
const { loadDeploymentManifest, resolveDeploymentManifestPath } = require('../../../deployment-config.cjs');

export const IM_LABELS = Object.freeze({ lark: '飞书', weixin: '微信', email: '邮箱' });

// The primary IM (`channel`) is where the bot reaches the owner unasked.
export const PRIMARY_MEANING = '你没找机器人、它主动找你时（比如新邮件提醒、待你确认的邮件回复）发到这里';

// A manifest agent's connectors, as the loader reads them.
export function connectorsOf(agent) {
  return agent.connectors ?? [agent.channel ?? 'lark'];
}

export function imList(connectors, mailboxes = 0) {
  return connectors.map((connector) => (connector === 'email' && mailboxes > 1
    ? `${IM_LABELS.email}×${mailboxes}` : IM_LABELS[connector] ?? connector)).join('、');
}

// The loaded manifest, or null while Vika has no instance yet.
export function loadInstances(env = process.env) {
  if (!fs.existsSync(resolveDeploymentManifestPath(env))) return null;
  return loadDeploymentManifest(env);
}

export function describeInstances(deployment) {
  const width = Math.max(...deployment.agents.map((agent) => agent.id.length));
  return deployment.agents.map((agent) => `  ${agent.id.padEnd(width)}  ${agent.displayName}  ${imList(agent.connectors, agent.emailAccounts?.length)}`).join('\n');
}

export async function chooseInstance({ deployment, requested, prompter, question }) {
  if (!deployment) throw new Error('还没有任何实例：先运行 vika setup');
  const { agents } = deployment;
  if (requested) {
    const agent = agents.find((candidate) => candidate.id === requested);
    if (!agent) throw new Error(`没有叫 ${requested} 的实例。现有实例：\n${describeInstances(deployment)}`);
    return agent;
  }
  if (agents.length === 1) return agents[0];
  if (!prompter?.tty) throw new Error(`有多个实例，请在命令后面写上实例名：\n${describeInstances(deployment)}`);
  return prompter.select(question, agents.map((agent) => ({
    label: `${agent.displayName}（${agent.id}）`, hint: imList(agent.connectors, agent.emailAccounts?.length), value: agent,
  })), { initial: Math.max(0, agents.findIndex((agent) => agent.id === deployment.defaultInstance)) });
}
