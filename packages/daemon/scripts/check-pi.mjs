import { execFileSync } from 'node:child_process';
import { assertPiVersion, managedPiBin, piCommand, PI_VERSION } from '../src/pi-runtime.mjs';

// Launch Pi exactly as the daemon does, so this check fails where the daemon would.
const { command, args } = piCommand(managedPiBin(), ['--version']);
assertPiVersion(execFileSync(command, args, { encoding: 'utf8', timeout: 15_000 }));
process.stdout.write(`Managed Pi ${PI_VERSION} is ready.\n`);
