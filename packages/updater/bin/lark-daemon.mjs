#!/usr/bin/env node
import http from 'node:http';
import { assertUpgradeTarget, defaultSocketPath } from '../src/targets.mjs';

function usage() {
  process.stderr.write('usage: lark-daemon upgrade <zayn|sally|all>\n');
}

function requestUpgrade(socketPath, target) {
  const body = JSON.stringify({ target });
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: '/v1/upgrade',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          reject(new Error(`updater returned invalid JSON (${response.statusCode})`));
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(payload.error || `updater returned ${response.statusCode}`));
          return;
        }
        resolve(payload);
      });
    });
    request.setTimeout(600_000, () => request.destroy(new Error('updater request timed out')));
    request.once('error', reject);
    request.end(body);
  });
}

const [command, target, ...extra] = process.argv.slice(2);
if (command !== 'upgrade' || !target || extra.length > 0) {
  usage();
  process.exitCode = 2;
} else {
  try {
    assertUpgradeTarget(target);
    const result = await requestUpgrade(
      process.env.LARK_UPDATER_SOCKET || defaultSocketPath(),
      target,
    );
    const apps = Array.isArray(result.apps) && result.apps.length > 0
      ? result.apps
      : [result.app].filter(Boolean);
    const commit = typeof result.commit === 'string' ? ` at ${result.commit.slice(0, 12)}` : '';
    const publication = result.published ? 'published and ' : '';
    process.stdout.write(`${publication}${apps.join(', ')} ${apps.length === 1 ? 'is' : 'are'} ready${commit} (${result.release})\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
