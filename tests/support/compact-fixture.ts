import { serve } from '@hono/node-server';
import { once } from 'node:events';
import {
  createMcpHandler,
  Server,
  inputRequired,
  acceptedContent,
  ProtocolError,
  type Tool,
} from '@modelcontextprotocol/server';
import { CallToolRequestParamsSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';

export interface CompactFixtureState {
  lists: number;
  invocations: number;
  effects: number;
  version: number;
  mismatch: boolean;
  outputInvalid: boolean;
  seenHeader: string;
  instructions: string;
}

export function createCompactFixtureState(): CompactFixtureState {
  return {
    lists: 0,
    invocations: 0,
    effects: 0,
    version: 1,
    mismatch: false,
    outputInvalid: false,
    seenHeader: '',
    instructions: 'Fixture arithmetic operations.',
  };
}

export function compactFixtureDefinition(state: CompactFixtureState): Tool {
  return {
    name: 'add_value',
    description: 'Add a number to the current value.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'integer', 'x-mcp-header': 'Value' },
        ...(state.version > 1 ? { increment: { type: 'number' } } : {}),
      },
      required: state.version > 1 ? ['value', 'increment'] : ['value'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    },
  };
}

export function createCompactFixtureServer(state: CompactFixtureState): Server {
  const server = new Server(
    { name: 'compact-fixture', version: '1' },
    {
      capabilities: { tools: {} },
      instructions: state.instructions,
      inputRequired: { legacyShim: true },
    },
  );
  server.setRequestHandler('tools/list', () => {
    state.lists++;
    return {
      tools: [
        compactFixtureDefinition(state),
        {
          name: 'confirm_value',
          description: 'Confirm a value before returning it.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
          },
        },
        {
          name: 'mixed_result',
          description: 'Return mixed content.',
          inputSchema: { type: 'object' },
        },
        {
          name: 'stateless_confirm',
          description: 'Request confirmation without persisting continuation state.',
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
          },
        },
      ],
    };
  });
  server.setRequestHandler(
    'tools/call',
    { params: CallToolRequestParamsSchema, result: z.looseObject({}) },
    async (request, context) => {
      state.invocations++;
      if (state.mismatch) {
        state.mismatch = false;
        state.version++;
        throw new ProtocolError(-32020, 'Contract changed during submission');
      }
      if (request.name === 'confirm_value') {
        const confirmed = acceptedContent(
          context.mcpReq.inputResponses,
          'confirmation',
          z.object({ confirmed: z.boolean() }),
        );
        if (!confirmed)
          return inputRequired({
            requestState: 'fixture-confirm',
            inputRequests: {
              confirmation: inputRequired.elicit({
                message: 'Confirm arithmetic',
                requestedSchema: z.object({ confirmed: z.boolean() }),
              }),
            },
          });
        if (context.mcpReq.requestState() !== 'fixture-confirm')
          throw new Error('Continuation state missing');
        state.effects++;
        const value = request.arguments?.value;
        return {
          content: [
            { type: 'text', text: JSON.stringify({ value, confirmed: confirmed.confirmed }) },
          ],
        };
      }
      if (request.name === 'mixed_result')
        return {
          content: [
            { type: 'text', text: 'fixture text' },
            { type: 'image', mimeType: 'image/png', data: 'ZmFrZQ==' },
            { type: 'resource_link', uri: 'fixture://resource', name: 'Fixture' },
          ],
          structuredContent: { value: 7 },
          _meta: { 'fixture/metadata': true },
        };
      if (request.name === 'stateless_confirm') {
        const confirmed = acceptedContent(
          context.mcpReq.inputResponses,
          'confirmation',
          z.object({ confirmed: z.boolean() }),
        );
        if (!confirmed)
          return inputRequired({
            // Deliberately no requestState: a client-driven continuation cannot
            // be correlated upstream and must never be replayed as a new call.
            inputRequests: {
              confirmation: inputRequired.elicit({
                message: 'Confirm without state',
                requestedSchema: z.object({ confirmed: z.boolean() }),
              }),
            },
          });
        state.effects++;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                value: request.arguments?.value,
                confirmed: confirmed.confirmed,
              }),
            },
          ],
          structuredContent: { value: request.arguments?.value, confirmed: confirmed.confirmed },
        };
      }
      state.effects++;
      state.seenHeader = context.http?.req?.headers.get('Mcp-Param-Value') ?? '';
      const value = Number(request.arguments?.value) + Number(request.arguments?.increment ?? 1);
      return {
        content: [{ type: 'text', text: JSON.stringify({ value }) }],
        structuredContent: { value: state.outputInvalid ? 'invalid' : value },
      };
    },
  );
  return server;
}

export async function startCompactFixture() {
  const state = createCompactFixtureState();
  const definition = (): Tool => compactFixtureDefinition(state);
  const handler = createMcpHandler(() => createCompactFixtureServer(state), { legacy: 'reject' });
  const http = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => handler.fetch(request),
  });
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return {
    state,
    definition,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export interface CompactAppFixtureState {
  invocations: number;
  effects: number;
}

export function createCompactAppFixtureState(): CompactAppFixtureState {
  return { invocations: 0, effects: 0 };
}

/**
 * A server where one tool carries MCP App UI metadata and another does not.
 * Compact must treat the whole server (including the plain companion) as
 * individual-endpoint only, so no App/companion tool is run through generic exec.
 */
export function createCompactAppFixtureServer(state: CompactAppFixtureState): Server {
  const server = new Server(
    { name: 'compact-app-fixture', version: '1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [
      {
        name: 'open_dashboard',
        description: 'Open the dashboard App.',
        inputSchema: { type: 'object' },
        _meta: { ui: { resourceUri: 'ui://fixture/dashboard' } },
      },
      {
        name: 'dashboard_action',
        description: 'Companion action exposed by the dashboard App.',
        inputSchema: { type: 'object' },
      },
    ],
  }));
  server.setRequestHandler(
    'tools/call',
    { params: CallToolRequestParamsSchema, result: z.looseObject({}) },
    async () => {
      state.invocations++;
      state.effects++;
      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
        structuredContent: { ok: true },
      };
    },
  );
  return server;
}

export async function startCompactAppFixture() {
  const state = createCompactAppFixtureState();
  const handler = createMcpHandler(() => createCompactAppFixtureServer(state), {
    legacy: 'reject',
  });
  const http = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => handler.fetch(request),
  });
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return {
    state,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export interface CompactTaskFixtureState {
  invocations: number;
  effects: number;
}

export function createCompactTaskFixtureState(): CompactTaskFixtureState {
  return { invocations: 0, effects: 0 };
}

/**
 * A 2025-era upstream is the only protocol revision whose `tools/list`
 * vocabulary still carries `execution.taskSupport` (the 2026 codec deletes it),
 * so this server is served with `legacy: 'stateless'` and registered by tests
 * with `protocolMode: 'legacy'` to exercise the compact Task gate.
 */
export function createCompactTaskFixtureServer(state: CompactTaskFixtureState): Server {
  const server = new Server(
    { name: 'compact-task-fixture', version: '1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', () => ({
    tools: [
      {
        name: 'task_required',
        description: 'Requires task execution.',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
        },
        execution: { taskSupport: 'required' },
      },
      {
        name: 'task_optional',
        description: 'Supports optional task execution.',
        inputSchema: { type: 'object' },
        execution: { taskSupport: 'optional' },
      },
    ],
  }));
  server.setRequestHandler(
    'tools/call',
    { params: CallToolRequestParamsSchema, result: z.looseObject({}) },
    async (request) => {
      state.invocations++;
      state.effects++;
      const taskSupport = request.name === 'task_required' ? 'required' : 'optional';
      return {
        content: [{ type: 'text', text: JSON.stringify({ taskSupport }) }],
        structuredContent: { taskSupport },
      };
    },
  );
  return server;
}

export async function startCompactTaskFixture() {
  const state = createCompactTaskFixtureState();
  const handler = createMcpHandler(() => createCompactTaskFixtureServer(state), {
    legacy: 'stateless',
  });
  const http = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => handler.fetch(request),
  });
  await once(http, 'listening');
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return {
    state,
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    async close() {
      await handler.close();
      await new Promise<void>((resolve, reject) =>
        http.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
