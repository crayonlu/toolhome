import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  acceptedContent,
  inputRequired,
  inputResponse,
  type McpRequestContext,
  type Tool,
} from '@modelcontextprotocol/server';
import { CallToolRequestParamsSchema } from '@modelcontextprotocol/core';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalTaskMethod } from '../../src/data-plane/task-extension.js';

const confirmationSchema = z.object({ confirmed: z.boolean() });
const looseResultSchema = z.looseObject({});

export interface FixtureTask extends Record<string, unknown> {
  resultType: 'complete';
  taskId: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs?: number;
  result?: unknown;
  error?: unknown;
  inputRequests?: Record<string, unknown>;
}

export interface FixtureState {
  dynamicTools: number;
  slowCancelled: number;
  slowStarted: number;
  tasks: Map<string, FixtureTask>;
}

export interface FixtureServerOptions {
  name: string;
  era: McpRequestContext['era'];
  authorization?: string | null;
  secret?: string | null;
  state: FixtureState;
}

export function createFixtureState(): FixtureState {
  return {
    dynamicTools: 0,
    slowCancelled: 0,
    slowStarted: 0,
    tasks: new Map(),
  };
}

export function createFixtureServer(options: FixtureServerOptions): Server {
  const server = new Server(
    { name: `fixture-${options.name}`, title: `Fixture ${options.name}`, version: '1.0.0' },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        completions: {},
        logging: {},
        extensions: {
          'io.modelcontextprotocol/tasks': {},
          'io.modelcontextprotocol/ui': {
            mimeTypes: ['text/html;profile=mcp-app'],
          },
          'dev.toolhome.fixture': { version: 1 },
        },
      },
      instructions: `Fixture server ${options.name}`,
      inputRequired: { legacyShim: true },
    },
  );

  server.setRequestHandler('tools/list', async () => {
    const tools: Tool[] = [
      tool('echo', 'Echo arguments and the injected credential'),
      tool('confirm', 'Request user confirmation'),
      tool('roots', 'Request roots from the MCP client'),
      tool('sample', 'Request sampling from the MCP client'),
      tool('progress', 'Report progress to the MCP client'),
      tool('slow', 'Wait until the MCP client cancels the request'),
      tool('start-task', 'Create a final Tasks extension task'),
      tool('app.action', 'A dotted tool invoked from the fixture MCP App'),
      {
        ...tool('open-dashboard', 'Open the fixture MCP App'),
        _meta: {
          ui: { resourceUri: 'ui://fixture/dashboard' },
          'ui/resourceUri': 'ui://fixture/dashboard',
        },
      },
    ];
    if (options.era === 'legacy') {
      tools.push(tool('client-extension', 'Call a fixture client extension'));
    }
    if (options.state.dynamicTools > 0) {
      tools.push(tool('dynamic', 'A tool added after a list change'));
    }
    return { tools };
  });

  server.setRequestHandler(
    'tools/call',
    { params: CallToolRequestParamsSchema, result: looseResultSchema },
    async (request, context) => {
      if (request.name === 'echo') {
        return textResult({
          arguments: request.arguments ?? {},
          authorization: options.authorization ?? null,
          secret: options.secret ?? null,
          server: options.name,
        });
      }

      if (request.name === 'confirm') {
        if (options.era === 'legacy') {
          const result = await context.mcpReq.elicitInput({
            mode: 'form',
            message: 'Confirm fixture action',
            requestedSchema: {
              type: 'object',
              properties: { confirmed: { type: 'boolean' } },
              required: ['confirmed'],
            },
          });
          return textResult({
            confirmed: result.action === 'accept' && result.content?.confirmed === true,
            source: 'legacy-push',
          });
        }
        const confirmation = acceptedContent(
          context.mcpReq.inputResponses,
          'confirmation',
          confirmationSchema,
        );
        if (!confirmation) {
          return inputRequired({
            inputRequests: {
              confirmation: inputRequired.elicit({
                message: 'Confirm fixture action',
                requestedSchema: confirmationSchema,
              }),
            },
          });
        }
        return textResult({ confirmed: confirmation.confirmed, source: 'modern-mrtr' });
      }

      if (request.name === 'roots') {
        if (options.era === 'legacy') {
          const result = await server.listRoots();
          return textResult({ roots: result.roots, source: 'legacy-push' });
        }
        const response = inputResponse(context.mcpReq.inputResponses, 'roots');
        if (response.kind !== 'roots') {
          return inputRequired({
            inputRequests: { roots: inputRequired.listRoots() },
          });
        }
        return textResult({ roots: response.roots, source: 'modern-mrtr' });
      }

      if (request.name === 'sample') {
        if (options.era === 'legacy') {
          const result = await context.mcpReq.requestSampling({
            maxTokens: 64,
            messages: [
              { role: 'user', content: { type: 'text', text: 'Sample fixture response' } },
            ],
          });
          return textResult({ result, source: 'legacy-push' });
        }
        const response = inputResponse(context.mcpReq.inputResponses, 'sampling');
        if (response.kind !== 'sampling') {
          return inputRequired({
            inputRequests: {
              sampling: inputRequired.createMessage({
                maxTokens: 64,
                messages: [
                  { role: 'user', content: { type: 'text', text: 'Sample fixture response' } },
                ],
              }),
            },
          });
        }
        return textResult({ result: response.result, source: 'modern-mrtr' });
      }

      if (request.name === 'client-extension') {
        const result = await context.mcpReq.send(
          {
            method: 'fixture/client-resource',
            params: {
              content: [
                {
                  type: 'resource_link',
                  uri: 'fixture://data',
                  name: 'Fixture data',
                },
              ],
            },
          },
          looseResultSchema,
        );
        return textResult({ result, source: 'legacy-client-extension' });
      }

      if (request.name === 'progress') {
        const token = progressToken(request._meta);
        if (token !== null) {
          await context.mcpReq.notify({
            method: 'notifications/progress',
            params: {
              progress: 1,
              total: 2,
              message: 'Fixture progress',
              progressToken: token,
            },
          });
        }
        return textResult({ progressed: token !== null });
      }

      if (request.name === 'slow') {
        options.state.slowStarted += 1;
        try {
          await waitForAbort(context.mcpReq.signal);
          return textResult({ cancelled: false });
        } catch (error) {
          options.state.slowCancelled += 1;
          throw error;
        }
      }

      if (request.name === 'dynamic') {
        return textResult({ version: options.state.dynamicTools });
      }

      if (request.name === 'start-task') {
        const timestamp = new Date().toISOString();
        const task: FixtureTask = {
          resultType: 'complete',
          taskId: `task-${randomUUID()}`,
          status: 'completed',
          statusMessage: 'Fixture task completed',
          createdAt: timestamp,
          lastUpdatedAt: timestamp,
          ttlMs: 60_000,
          pollIntervalMs: 250,
          result: {
            content: [
              {
                type: 'resource_link',
                uri: 'fixture://data',
                name: 'Fixture task resource',
              },
            ],
            structuredContent: { task: 'complete', server: options.name },
          },
        };
        options.state.tasks.set(task.taskId, task);
        if (context.mcpReq.envelope === undefined) {
          await context.mcpReq.notify({
            method: 'notifications/tasks/status',
            params: {
              taskId: task.taskId,
              status: task.status,
              statusMessage: task.statusMessage,
              createdAt: task.createdAt,
              lastUpdatedAt: task.lastUpdatedAt,
              ttlMs: task.ttlMs,
              pollIntervalMs: task.pollIntervalMs,
            },
          });
        }
        return {
          resultType: 'task',
          taskId: task.taskId,
          status: task.status,
          statusMessage: task.statusMessage,
          createdAt: task.createdAt,
          lastUpdatedAt: task.lastUpdatedAt,
          ttlMs: task.ttlMs,
          pollIntervalMs: task.pollIntervalMs,
        };
      }

      if (request.name === 'open-dashboard') {
        return {
          content: [
            {
              type: 'resource_link',
              uri: 'ui://fixture/dashboard',
              name: 'Fixture dashboard',
              mimeType: 'text/html;profile=mcp-app',
            },
          ],
        };
      }

      if (request.name === 'app.action') {
        return textResult({ appAction: true, server: options.name });
      }

      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${request.name}`);
    },
  );

  server.setRequestHandler('prompts/list', async () => ({
    prompts: [
      {
        name: 'greet',
        title: 'Greeting',
        description: 'Create a greeting',
        arguments: [{ name: 'name', required: true }],
      },
      {
        name: 'confirm-prompt',
        title: 'Confirmation prompt',
        description: 'Confirm before returning a prompt',
      },
    ],
  }));

  server.setRequestHandler('prompts/get', async (request, context) => {
    if (request.params.name === 'confirm-prompt' && options.era === 'legacy') {
      const result = await context.mcpReq.elicitInput({
        mode: 'form',
        message: 'Confirm fixture prompt',
        requestedSchema: {
          type: 'object',
          properties: { confirmed: { type: 'boolean' } },
          required: ['confirmed'],
        },
      });
      return {
        description: result.action === 'accept' ? 'legacy-push' : 'declined',
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: 'Confirmed fixture prompt' },
          },
        ],
      };
    }
    return {
      description: 'Fixture greeting',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Hello ${request.params.arguments?.name ?? 'there'} from ${options.name}`,
          },
        },
      ],
    };
  });

  server.setRequestHandler('resources/list', async () => ({
    resources: [
      {
        uri: 'fixture://data',
        name: 'Fixture data',
        mimeType: 'application/json',
      },
      {
        uri: 'ui://fixture/dashboard',
        name: 'Fixture dashboard',
        mimeType: 'text/html;profile=mcp-app',
      },
      {
        uri: 'fixture://interactive',
        name: 'Interactive fixture resource',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler('resources/templates/list', async () => ({
    resourceTemplates: [
      {
        uriTemplate: 'fixture://items/{id}',
        name: 'Fixture item',
        mimeType: 'application/json',
      },
    ],
  }));

  server.setRequestHandler('resources/read', async (request, context) => {
    if (request.params.uri === 'ui://fixture/dashboard') {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'text/html;profile=mcp-app',
            text: '<main><h1>Fixture dashboard</h1></main>',
          },
        ],
      };
    }
    if (request.params.uri === 'fixture://interactive' && options.era === 'legacy') {
      const result = await context.mcpReq.elicitInput({
        mode: 'form',
        message: 'Confirm fixture resource',
        requestedSchema: {
          type: 'object',
          properties: { confirmed: { type: 'boolean' } },
          required: ['confirmed'],
        },
      });
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              confirmed: result.action === 'accept',
              source: 'legacy-push',
            }),
          },
        ],
      };
    }
    if (request.params.uri === 'fixture://interactive') {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'application/json',
            text: JSON.stringify({ confirmed: true, source: 'direct' }),
          },
        ],
      };
    }
    if (
      request.params.uri === 'fixture://data' ||
      request.params.uri.startsWith('fixture://items/')
    ) {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: 'application/json',
            text: JSON.stringify({ server: options.name, uri: request.params.uri }),
          },
        ],
      };
    }
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown fixture resource');
  });

  server.setRequestHandler('completion/complete', async (request) => ({
    completion: {
      values: [`${request.params.argument.value}-one`, `${request.params.argument.value}-two`],
      total: 2,
      hasMore: false,
    },
  }));

  server.fallbackRequestHandler = async (request, context) => {
    const taskMethod = canonicalTaskMethod(request.method);
    if (taskMethod === 'tasks/get') {
      const task = findTask(options.state, request.params?.taskId);
      return task;
    }
    if (taskMethod === 'tasks/update') {
      findTask(options.state, request.params?.taskId);
      return { resultType: 'complete' };
    }
    if (taskMethod === 'tasks/cancel') {
      const task = findTask(options.state, request.params?.taskId);
      const cancelled: FixtureTask = {
        ...task,
        status: 'cancelled',
        statusMessage: 'Fixture task cancelled',
        lastUpdatedAt: new Date().toISOString(),
      };
      options.state.tasks.set(cancelled.taskId, cancelled);
      return { resultType: 'complete' };
    }
    if (request.method === 'fixture/echo') {
      await context.mcpReq.notify({
        method: 'fixture/event',
        params: { echoed: request.params ?? {} },
      });
      return { resultType: 'complete', echoed: request.params ?? {} };
    }
    throw new ProtocolError(ProtocolErrorCode.MethodNotFound, request.method);
  };

  return server;
}

function tool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: true,
    },
  };
}

function textResult(value: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function findTask(state: FixtureState, value: unknown): FixtureTask {
  if (typeof value !== 'string') {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'taskId is required');
  }
  const task = state.tasks.get(value);
  if (!task) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown fixture task');
  return task;
}

function progressToken(value: unknown): string | number | null {
  if (!isRecord(value)) return null;
  const token = value.progressToken;
  return typeof token === 'string' || typeof token === 'number' ? token : null;
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, 30_000);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Fixture request cancelled');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
