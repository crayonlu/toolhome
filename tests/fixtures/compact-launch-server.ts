import { serveStdio } from '@modelcontextprotocol/server/stdio';
import {
  createCompactFixtureServer,
  createCompactFixtureState,
} from '../support/compact-fixture.js';

// Node-hosted fixture: the compact arithmetic surface served over legacy stdio,
// so a real CLI local gateway can mirror and then exec/drive it.
const state = createCompactFixtureState();

serveStdio(() => createCompactFixtureServer(state), { legacy: 'serve' });
