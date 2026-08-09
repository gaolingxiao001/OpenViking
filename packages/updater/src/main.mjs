#!/usr/bin/env node
import { createUpdaterServer } from './server.mjs';

const updater = await createUpdaterServer();
if (typeof process.send === 'function') process.send('ready');

async function stop() {
  await updater.close();
  process.exit(0);
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
