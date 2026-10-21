#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { hostPlatform } from '../packages/updater/src/artifacts.mjs';
import { installSlackCliBinary } from './release/slack-cli.mjs';

const { bin, version } = await installSlackCliBinary({ root: fileURLToPath(new URL('..', import.meta.url)), platformId: hostPlatform() });
process.stdout.write(`Slack CLI ${version} installed at ${bin}\n`);
