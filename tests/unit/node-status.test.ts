import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readNodeStatus } from '../../src/node/status.js';
import { SecretBox } from '../../src/security/secret-box.js';
import { SqliteStore } from '../../src/storage/sqlite-store.js';

const settings = {
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  maxTotalTimeoutMs: 600_000,
  maxConcurrency: 1,
  restart: 'on-failure' as const,
};

function snapshot(serverId: string, toolName: string) {
  const tool = { name: toolName, inputSchema: { type: 'object' as const, properties: {} } };
  return {
    serverId,
    version: 1,
    protocolVersion: '2026-07-28',
    protocolEra: 'modern' as const,
    serverInfo: { name: 'fixture', version: '1.0.0' },
    fingerprint: 'fixture-fingerprint',
    refreshedAt: '2026-10-02T10:00:00.000Z',
    capabilities: { tools: { listChanged: false } },
    instructions: null,
    tools: [tool],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    listResults: {
      tools: { tools: [tool] },
      resources: { resources: [] },
      resourceTemplates: { resourceTemplates: [] },
      prompts: { prompts: [] },
    },
  };
}

describe('node status report', () => {
  it('reports placement, probe, snapshot and call counts from the mirror', () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-node-status-'));
    const path = join(directory, 'node.sqlite');
    const store = new SqliteStore(path, new SecretBox(`toolhome-local-node:laptop`));
    const good = store.createServer({
      slug: 'laptop-chrome',
      name: 'Chrome',
      kind: 'node',
      nodeId: 'laptop',
      transport: {
        type: 'stdio',
        command: 'node',
        args: ['-v'],
        env: {},
        protocolMode: 'auto' as const,
      },
      credentialId: null,
      enabled: true,
      settings,
    });
    store.saveSnapshot(snapshot(good.id, 'greet'));
    store.insertToolCalls([
      {
        endpointType: 'aggregate',
        principalKind: 'access_key',
        principalId: 'key',
        serverId: good.id,
        exposedToolName: 'laptop-chrome.greet',
        upstreamToolName: 'greet',
        status: 'success',
        errorType: null,
        startedAt: '2026-10-02T10:00:00.000Z',
        completedAt: '2026-10-02T10:00:01.000Z',
        durationMs: 5,
      },
    ]);
    store.createServer({
      slug: 'broken',
      name: 'Broken',
      kind: 'node',
      nodeId: 'laptop',
      transport: {
        type: 'stdio',
        command: '/nonexistent/bridge',
        args: [],
        env: {},
        protocolMode: 'auto' as const,
      },
      credentialId: null,
      enabled: true,
      settings,
    });
    store.createServer({
      slug: 'elsewhere',
      name: 'Other node',
      kind: 'node',
      nodeId: 'desktop',
      transport: {
        type: 'stdio',
        command: 'node',
        args: [],
        env: {},
        protocolMode: 'auto' as const,
      },
      credentialId: null,
      enabled: true,
      settings,
    });
    store.close();

    const report = readNodeStatus({ nodeId: 'laptop', storePath: path });
    expect(report.mirrorExists).toBe(true);
    expect(report.servers.map((server) => server.slug)).toEqual(['broken', 'laptop-chrome']);

    const healthy = report.servers.find((server) => server.slug === 'laptop-chrome')!;
    expect(healthy).toMatchObject({
      status: 'unknown',
      tools: 1,
      resources: 0,
      prompts: 0,
      calls: 1,
      lastCallAt: '2026-10-02T10:00:00.000Z',
    });
    expect(healthy.probe.ok).toBe(true);

    const broken = report.servers.find((server) => server.slug === 'broken')!;
    expect(broken.tools).toBeNull();
    expect(broken.probe).toMatchObject({ ok: false, detail: '/nonexistent/bridge (missing)' });

    rmSync(directory, { recursive: true, force: true });
  });

  it('handles a mirror that does not exist yet', () => {
    const report = readNodeStatus({
      nodeId: 'laptop',
      storePath: join(tmpdir(), `toolhome-absent-${Date.now()}.sqlite`),
    });
    expect(report).toMatchObject({ mirrorExists: false, servers: [] });
  });
});
