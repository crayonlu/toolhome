import { appendFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createFixtureServer, createFixtureState } from './mcp-server.js';

if (process.env.FIXTURE_START_LOG) appendFileSync(process.env.FIXTURE_START_LOG, 'started\n');
const state = createFixtureState();
const fixtureSecret = process.env.FIXTURE_SECRET ?? null;

if (fixtureSecret) process.stderr.write(`fixture credential: ${fixtureSecret}\n`);

serveStdio(
  (context) =>
    createFixtureServer({
      name: 'home',
      era: context.era,
      secret: fixtureSecret,
      state,
    }),
  { legacy: 'serve' },
);
