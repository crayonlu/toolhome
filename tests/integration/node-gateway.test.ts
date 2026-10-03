import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { once } from 'node:events';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ControlClient } from '../../src/control/client.js';
import { prepareLocalGateway } from '../../src/node/local-gateway.js';
import { controlRequest, createTestRuntime, jsonResponse } from '../support/runtime.js';

const fixturePath = fileURLToPath(new URL('../fixtures/stdio-server.ts', import.meta.url));
const cliPath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

describe('local node gateway', () => {
  it('lists compatible names and routes tool calls over stdio', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-node-gateway-'));
    const configPath = join(directory, 'config.json');
    const runtime = createTestRuntime({ config: { allowedHosts: ['toolhome.test', '127.0.0.1'] } });
    const server = serve({
      fetch: runtime.runtime.app.fetch,
      hostname: '127.0.0.1',
      port: 0,
    });
    let client: Client | undefined;
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test address unavailable');
      const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
      const created = (await jsonResponse(
        await controlRequest(runtime.runtime, runtime.controlKey, 'POST', '/api/v1/servers', {
          slug: 'local-fixture',
          name: 'Local fixture',
          kind: 'node',
          nodeId: 'local-test',
          transport: {
            type: 'stdio',
            command: process.execPath,
            args: ['--import', 'tsx', fixturePath],
            protocolMode: 'legacy',
          },
        }),
      )) as { id: string };
      expect(created.id).toBeTruthy();
      writeFileSync(
        configPath,
        JSON.stringify({
          url: baseUrl.toString(),
          controlKey: runtime.controlKey,
          nodeId: 'local-test',
        }),
      );
      const gateway = await prepareLocalGateway({
        client: new ControlClient(baseUrl, runtime.controlKey),
        nodeId: 'local-test',
        storePath: join(directory, 'node.sqlite'),
      });
      try {
        expect(await gateway.discoverSnapshots()).toMatchObject([
          { slug: 'local-fixture', ok: true },
        ]);
      } finally {
        await gateway.close();
      }

      client = new Client({ name: 'node-test', version: '1.0.0' }, { capabilities: {} });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', cliPath, 'mcp', 'stdio'],
          env: {
            ...process.env,
            TOOLHOME_CONFIG: configPath,
            TOOLHOME_URL: baseUrl.toString(),
            TOOLHOME_CONTROL_KEY: runtime.controlKey,
          },
          stderr: 'pipe',
        }),
        { timeout: 10_000 },
      );
      const tools = (await client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toContain('local-fixture_echo');
      expect(tools.map((tool) => tool.name)).toContain('local-fixture_app-2eaction');
      expect(tools.every((tool) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(tool.name))).toBe(true);
      const result = await client.callTool({
        name: 'local-fixture_echo',
        arguments: { local: true },
      });
      expect(result.structuredContent).toMatchObject({
        arguments: { local: true },
        server: 'home',
      });
    } finally {
      await client?.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
