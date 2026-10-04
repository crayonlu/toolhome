import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { Server } from '@modelcontextprotocol/server';
import { CallToolRequestParamsSchema } from '@modelcontextprotocol/core';
import { z } from 'zod';

const transport = new StdioServerTransport();
const send = transport.send.bind(transport);
let bufferedProgress: string | null = null;
transport.send = async (message) => {
  if (
    'method' in message &&
    message.method === 'notifications/progress' &&
    message.params?.total === 1
  ) {
    bufferedProgress = `${JSON.stringify(message)}\n`;
    return;
  }
  if (bufferedProgress !== null && 'id' in message && !('method' in message)) {
    const batch = bufferedProgress + `${JSON.stringify(message)}\n`;
    bufferedProgress = null;
    await new Promise<void>((resolve, reject) =>
      process.stdout.write(batch, (error) => (error ? reject(error) : resolve())),
    );
    return;
  }
  await send(message);
};

let effects = 0;
let calls = 0;
let lists = 0;
serveStdio(
  () => {
    const server = new Server(
      { name: 'compact-legacy', version: '1' },
      { capabilities: { tools: {} }, inputRequired: { legacyShim: true } },
    );
    server.setRequestHandler('tools/list', () => {
      lists++;
      return {
        tools: ['confirm', 'slow', 'state', 'roots', 'sample', 'progress'].map((name) => ({
          name,
          inputSchema: { type: 'object' as const },
        })),
      };
    });
    server.setRequestHandler(
      'tools/call',
      { params: CallToolRequestParamsSchema, result: z.looseObject({}) },
      async (request, context) => {
        if (request.name === 'state')
          return { content: [{ type: 'text', text: JSON.stringify({ effects, calls, lists }) }] };
        if (request.name === 'roots') {
          return { content: [{ type: 'text', text: JSON.stringify(await server.listRoots()) }] };
        }
        if (request.name === 'sample') {
          const result = await context.mcpReq.requestSampling({
            maxTokens: 64,
            messages: [{ role: 'user', content: { type: 'text', text: 'Fixture sampling' } }],
          });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }
        if (request.name === 'progress') {
          const token = request._meta?.progressToken;
          if (token !== undefined)
            await context.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken: token, progress: 1, total: 1 },
            });
          if (request.arguments?.fail) throw new Error('Fixture progress failure');
          return {
            content: [{ type: 'text', text: JSON.stringify({ progressed: token !== undefined }) }],
          };
        }
        calls++;
        effects++;
        if (request.name === 'slow') {
          const token = request._meta?.progressToken;
          if (token !== undefined) {
            await context.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken: token, progress: 1, total: 2 },
            });
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 5000);
            context.mcpReq.signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('Fixture request cancelled'));
              },
              { once: true },
            );
          });
          return { content: [{ type: 'text', text: 'completed' }] };
        }
        if (
          request.arguments?.marker === 'progress' &&
          request._meta?.progressToken !== undefined
        ) {
          await context.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken: request._meta.progressToken, progress: 1, total: 2 },
          });
        }
        const input = await context.mcpReq.elicitInput({
          mode: 'form',
          message: 'Confirm fixture effect',
          requestedSchema: {
            type: 'object',
            properties: { confirmed: { type: 'boolean' } },
            required: ['confirmed'],
          },
        });
        if (request.arguments?.marker === 'delayed') {
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ effects, calls, lists, accepted: input.action === 'accept' }),
            },
          ],
        };
      },
    );
    return server;
  },
  { legacy: 'serve', transport },
);
