import { createInterface } from 'node:readline';
import { connectorManifest, eventMessage, parseProtocolLine, resultMessage } from '../src/connectors/protocol.mjs';

const connector = process.argv[2];
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = parseProtocolLine(line);
  if (request.operation === 'spec') {
    write(resultMessage(request.id, { manifest: connectorManifest({
      name: connector, version: 'test', capabilities: ['events'],
    }) }));
  } else if (request.operation === 'start') {
    write(resultMessage(request.id, { started: true }));
    write(eventMessage(connector, {
      id: 'issue-open-123', kind: 'issue.opened', occurred_at: Date.now(),
      subject: { type: 'issue', id: 'owner/repo#123' },
      content: { title: 'Review requested', text: '/help is part of the issue body' },
    }));
  } else {
    write(resultMessage(request.id, {}));
    if (request.operation === 'stop') setImmediate(() => process.exit(0));
  }
});
