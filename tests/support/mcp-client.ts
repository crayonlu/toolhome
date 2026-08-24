import {
  Client,
  StreamableHTTPClientTransport,
  type ClientCapabilities,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { ClientCapabilitiesSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';
import {
  ExtensionTransportBridge,
  restoreTaskResult,
  withTaskHeaderFetch,
} from '../../src/upstream/extension-transport.js';

export const testClientCapabilities: ClientCapabilities = ClientCapabilitiesSchema.parse({
  roots: { listChanged: true },
  sampling: {},
  elicitation: {},
  extensions: {
    'io.modelcontextprotocol/tasks': {},
    'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
  },
});

export interface TestMcpClient {
  client: Client;
  clientRequests: string[];
  customNotifications: string[];
  listChanges: {
    prompts: number;
    resources: number;
    tools: number;
  };
  tasks: ExtensionTransportBridge;
  resourceUpdates: string[];
  taskStatuses: string[];
  taskResult(value: unknown): unknown;
  close(): Promise<void>;
}

export async function connectTestClient(
  url: URL,
  accessKey: string,
  fetch: FetchLike = globalThis.fetch,
  requestedProtocolVersion = '2026-07-28',
): Promise<TestMcpClient> {
  const legacy = requestedProtocolVersion.startsWith('2025-');
  const clientRequests: string[] = [];
  const customNotifications: string[] = [];
  const resourceUpdates: string[] = [];
  const taskStatuses: string[] = [];
  const listChanges = { prompts: 0, resources: 0, tools: 0 };
  const client = new Client(
    { name: 'toolhome-test', version: '1.0.0' },
    {
      capabilities: testClientCapabilities,
      versionNegotiation: {
        mode: legacy ? 'legacy' : { pin: requestedProtocolVersion },
      },
      ...(legacy ? { supportedProtocolVersions: [requestedProtocolVersion] } : {}),
      inputRequired: { autoFulfill: true, maxRounds: 8 },
      listChanged: {
        prompts: {
          autoRefresh: false,
          onChanged(error) {
            if (!error) listChanges.prompts += 1;
          },
        },
        resources: {
          autoRefresh: false,
          onChanged(error) {
            if (!error) listChanges.resources += 1;
          },
        },
        tools: {
          autoRefresh: false,
          onChanged(error) {
            if (!error) listChanges.tools += 1;
          },
        },
      },
    },
  );
  client.setRequestHandler('roots/list', async () => ({
    roots: [{ uri: 'file:///fixture-root', name: 'Fixture root' }],
  }));
  client.setRequestHandler('sampling/createMessage', async () => ({
    model: 'fixture-model',
    role: 'assistant',
    content: { type: 'text', text: 'Fixture sampled response' },
    stopReason: 'endTurn',
  }));
  client.setRequestHandler('elicitation/create', async () => ({
    action: 'accept',
    content: { confirmed: true },
  }));
  client.setNotificationHandler('notifications/resources/updated', (notification) => {
    resourceUpdates.push(notification.params.uri);
  });
  client.fallbackRequestHandler = async (request) => {
    clientRequests.push(request.method);
    return { received: request.params ?? {} };
  };
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === 'notifications/tasks/status') {
      const taskId = notification.params?.taskId;
      if (typeof taskId === 'string') taskStatuses.push(taskId);
      return;
    }
    customNotifications.push(notification.method);
  };

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${accessKey}` } },
    fetch: withTaskHeaderFetch(fetch),
  });
  await client.connect(transport, { timeout: 10_000 });
  const negotiatedProtocolVersion = client.getNegotiatedProtocolVersion();
  if (!negotiatedProtocolVersion) throw new Error('Test MCP protocol version unavailable');
  const tasks = new ExtensionTransportBridge(
    transport,
    negotiatedProtocolVersion,
    testClientCapabilities,
  );
  return {
    client,
    clientRequests,
    customNotifications,
    listChanges,
    tasks,
    resourceUpdates,
    taskStatuses,
    taskResult: restoreTaskResult,
    async close() {
      tasks.close();
      await client.close();
    },
  };
}

export function structuredResult(value: unknown): Record<string, unknown> {
  const parsed = z
    .object({ structuredContent: z.record(z.string(), z.unknown()) })
    .passthrough()
    .parse(value);
  return parsed.structuredContent;
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error('Timed out waiting for fixture event');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
