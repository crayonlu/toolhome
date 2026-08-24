import type { FetchLike } from '@modelcontextprotocol/client';
import {
  apiKeyRecordSchema,
  credentialRecordSchema,
  serverRecordSchema,
} from '../../src/domain/models.js';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  connectTestClient,
  structuredResult,
  waitFor,
  type TestMcpClient,
} from '../support/mcp-client.js';
import { startRemoteFixture } from '../support/remote-fixture.js';
import {
  applicationFetch,
  controlRequest,
  createTestRuntime,
  jsonResponse,
} from '../support/runtime.js';

const issuedKeySchema = z.object({
  key: apiKeyRecordSchema,
  secret: z.string().min(1),
});
const createdTaskSchema = z
  .object({
    resultType: z.literal('task'),
    taskId: z.string().min(1),
    status: z.string(),
  })
  .passthrough();
const taskSchema = z
  .object({
    resultType: z.literal('complete'),
    taskId: z.string().min(1),
    status: z.string(),
  })
  .passthrough();
const customResultSchema = z.object({ echoed: z.record(z.string(), z.unknown()) }).passthrough();

describe('MCP gateway', () => {
  it('preserves modern, legacy, Apps, Tasks, subscriptions, credentials and extensions', async () => {
    const remote = await startRemoteFixture();
    const testRuntime = createTestRuntime();
    const clients: TestMcpClient[] = [];
    try {
      const remoteCredential = credentialRecordSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/credentials',
            {
              name: 'Remote bearer',
              payload: { type: 'bearer', token: 'remote-fixture-token' },
            },
          ),
        ),
      );
      const homeCredential = credentialRecordSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/credentials',
            {
              name: 'Home environment',
              payload: { type: 'env', variables: { FIXTURE_SECRET: 'home-fixture-secret' } },
            },
          ),
        ),
      );
      const remoteServer = serverRecordSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/servers',
            {
              slug: 'remote',
              name: 'Remote fixture',
              kind: 'remote',
              transport: {
                type: 'streamable-http',
                url: remote.url.toString(),
                protocolMode: 'modern',
                allowSseFallback: false,
                headers: {},
              },
              credentialId: remoteCredential.id,
              enabled: true,
              settings: { maxConcurrency: 4 },
            },
          ),
        ),
      );
      const fixturePath = fileURLToPath(new URL('../fixtures/stdio-server.ts', import.meta.url));
      const homeServer = serverRecordSchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/servers',
            {
              slug: 'home',
              name: 'Home fixture',
              kind: 'home',
              transport: {
                type: 'stdio',
                command: process.execPath,
                args: ['--import', 'tsx', fixturePath],
                env: {},
                protocolMode: 'legacy',
              },
              credentialId: homeCredential.id,
              enabled: true,
              settings: { maxConcurrency: 2 },
            },
          ),
        ),
      );

      await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          testRuntime.controlKey,
          'POST',
          `/api/v1/servers/${remoteServer.id}/refresh`,
        ),
      );
      await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          testRuntime.controlKey,
          'POST',
          `/api/v1/servers/${homeServer.id}/refresh`,
        ),
      );
      const homeLogs = await jsonResponse(
        await controlRequest(
          testRuntime.runtime,
          testRuntime.controlKey,
          'GET',
          `/api/v1/servers/${homeServer.id}/logs`,
        ),
      );
      expect(JSON.stringify(homeLogs)).toContain('[REDACTED]');
      expect(JSON.stringify(homeLogs)).not.toContain('home-fixture-secret');
      const ready = await applicationFetch(
        testRuntime.runtime,
        new URL('/readyz', testRuntime.runtime.config.publicUrl),
      );
      expect(ready.status).toBe(200);

      const access = issuedKeySchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/access-keys',
            { name: 'Integration harness' },
          ),
        ),
      );

      const controlKeys = z
        .array(apiKeyRecordSchema)
        .parse(
          await jsonResponse(
            await controlRequest(
              testRuntime.runtime,
              testRuntime.controlKey,
              'GET',
              '/api/v1/control-keys',
            ),
          ),
        );
      const bootstrapKey = controlKeys.find((key) => key.name === 'bootstrap');
      if (!bootstrapKey) throw new Error('Bootstrap Control Key unavailable');
      const lastControlRevoke = await controlRequest(
        testRuntime.runtime,
        testRuntime.controlKey,
        'DELETE',
        `/api/v1/control-keys/${bootstrapKey.id}`,
      );
      expect(lastControlRevoke.status).toBe(409);
      const replacementControl = issuedKeySchema.parse(
        await jsonResponse(
          await controlRequest(
            testRuntime.runtime,
            testRuntime.controlKey,
            'POST',
            '/api/v1/control-keys',
            { name: 'Replacement control' },
          ),
        ),
      );
      expect(replacementControl.secret).toMatch(/^mch_ctl_/);

      const accessOnControl = await controlRequest(
        testRuntime.runtime,
        access.secret,
        'GET',
        '/api/v1/servers',
      );
      expect(accessOnControl.status).toBe(401);
      const controlOnMcp = await applicationFetch(
        testRuntime.runtime,
        new URL('/mcp', testRuntime.runtime.config.publicUrl),
        { headers: { authorization: `Bearer ${testRuntime.controlKey}` } },
      );
      expect(controlOnMcp.status).toBe(401);

      const appFetch: FetchLike = (input, init) =>
        applicationFetch(testRuntime.runtime, input, init);
      const aggregate = await connectTestClient(
        new URL('/mcp', testRuntime.runtime.config.publicUrl),
        access.secret,
        appFetch,
      );
      clients.push(aggregate);

      const tools = await aggregate.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'remote.echo',
          'home.echo',
          'remote.confirm',
          'home.confirm',
          'remote.start-task',
        ]),
      );
      const appTool = tools.tools.find((tool) => tool.name === 'remote.open-dashboard');
      const appUi = appTool?._meta?.ui;
      expect(appTool?._meta?.['ui/resourceUri']).toMatch(/^ui:\/\/toolhome\/remote\/resource\//);
      expect(isRecord(appUi) ? appUi.resourceUri : undefined).toMatch(
        /^ui:\/\/toolhome\/remote\/resource\//,
      );

      const remoteEcho = structuredResult(
        await aggregate.client.callTool({
          name: 'remote.echo',
          arguments: { message: 'hello' },
        }),
      );
      expect(remoteEcho).toMatchObject({
        authorization: 'Bearer remote-fixture-token',
        server: 'remote',
      });
      const homeEcho = structuredResult(
        await aggregate.client.callTool({ name: 'home.echo', arguments: {} }),
      );
      expect(homeEcho).toMatchObject({ secret: 'home-fixture-secret', server: 'home' });

      for (const interaction of [
        { name: 'remote.confirm', source: 'modern-mrtr' },
        { name: 'home.confirm', source: 'legacy-push' },
        { name: 'remote.roots', source: 'modern-mrtr' },
        { name: 'home.roots', source: 'legacy-push' },
        { name: 'remote.sample', source: 'modern-mrtr' },
        { name: 'home.sample', source: 'legacy-push' },
      ]) {
        const result = structuredResult(
          await aggregate.client.callTool({ name: interaction.name, arguments: {} }),
        );
        expect(result.source).toBe(interaction.source);
      }

      const resources = await aggregate.client.listResources();
      const remoteData = resources.resources.find(
        (item) => item.name === 'Fixture data' && item.uri.includes('remote'),
      );
      const remoteApp = resources.resources.find((item) =>
        item.uri.startsWith('ui://toolhome/remote/'),
      );
      const homeInteractive = resources.resources.find(
        (item) => item.name === 'Interactive fixture resource' && item.uri.includes('home'),
      );
      expect(remoteData?.uri).toMatch(/^toolhome:\/\/remote\/resource\//);
      expect(remoteApp?.uri).toMatch(/^ui:\/\/toolhome\/remote\/resource\//);
      if (!remoteData || !remoteApp || !homeInteractive) {
        throw new Error('Virtual fixture resources unavailable');
      }

      const restoredArgument = structuredResult(
        await aggregate.client.callTool({
          name: 'remote.echo',
          arguments: { uri: remoteData.uri },
        }),
      );
      expect(restoredArgument.arguments).toEqual({ uri: 'fixture://data' });
      const resource = await aggregate.client.readResource({ uri: remoteData.uri });
      expect(resource.contents[0]?.uri).toBe(remoteData.uri);
      const interactive = await aggregate.client.readResource({ uri: homeInteractive.uri });
      const interactiveContent = z
        .object({ uri: z.string(), text: z.string() })
        .passthrough()
        .parse(interactive.contents[0]);
      expect(interactiveContent.uri).toBe(homeInteractive.uri);
      expect(JSON.parse(interactiveContent.text)).toMatchObject({
        confirmed: true,
        source: 'legacy-push',
      });
      const appResource = await aggregate.client.readResource({ uri: remoteApp.uri });
      expect(appResource.contents[0]?.uri).toBe(remoteApp.uri);
      expect(appResource.contents[0]?.mimeType).toBe('text/html;profile=mcp-app');
      const appAction = structuredResult(
        await aggregate.client.callTool({
          name: 'app.action',
          arguments: {},
          _meta: { ui: { resourceUri: remoteApp.uri } },
        }),
      );
      expect(appAction).toMatchObject({ appAction: true, server: 'remote' });

      const templates = await aggregate.client.listResourceTemplates();
      const template = templates.resourceTemplates.find((item) =>
        item.uriTemplate.includes('remote'),
      );
      expect(template?.uriTemplate).toContain('/template/');
      if (!template) throw new Error('Virtual resource template unavailable');
      const expanded = template.uriTemplate.replace(/\{\?[^}]+\}$/, '?id=42');
      const templatedResource = await aggregate.client.readResource({ uri: expanded });
      expect(templatedResource.contents[0]?.uri).toMatch(/^toolhome:\/\/remote\/resource\//);
      const templatedContent = z
        .object({ text: z.string() })
        .passthrough()
        .parse(templatedResource.contents[0]);
      expect(templatedContent.text).toContain('fixture://items/42');

      const prompts = await aggregate.client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
        expect.arrayContaining(['remote.greet', 'home.greet', 'home.confirm-prompt']),
      );
      const prompt = await aggregate.client.getPrompt({
        name: 'remote.greet',
        arguments: { name: 'ToolHome' },
      });
      expect(prompt.messages[0]?.content).toMatchObject({
        type: 'text',
        text: 'Hello ToolHome from remote',
      });
      const interactivePrompt = await aggregate.client.getPrompt({
        name: 'home.confirm-prompt',
      });
      expect(interactivePrompt.description).toBe('legacy-push');
      const completion = await aggregate.client.complete({
        ref: { type: 'ref/prompt', name: 'remote.greet' },
        argument: { name: 'name', value: 'mcp' },
      });
      expect(completion.completion.values).toEqual(['mcp-one', 'mcp-two']);
      const appCall = await aggregate.client.callTool({
        name: 'remote.open-dashboard',
        arguments: {},
      });
      const link = z
        .object({
          content: z.array(
            z.object({ type: z.string(), uri: z.string().optional() }).passthrough(),
          ),
        })
        .parse(appCall)
        .content.find((item) => item.type === 'resource_link');
      expect(link?.uri).toBe(remoteApp.uri);

      const extension = await aggregate.client.request(
        {
          method: 'toolhome/remote/fixture/echo',
          params: { value: 'extension-value' },
        },
        customResultSchema,
      );
      expect(extension.echoed).toEqual({ value: 'extension-value' });
      expect(aggregate.customNotifications).toContain('toolhome/remote/fixture/event');

      const progress: number[] = [];
      const progressResult = structuredResult(
        await aggregate.client.callTool(
          { name: 'remote.progress', arguments: {} },
          {
            onprogress(update) {
              progress.push(update.progress);
            },
          },
        ),
      );
      expect(progressResult.progressed).toBe(true);
      expect(progress).toContain(1);

      const controller = new AbortController();
      const cancellation: Promise<{ kind: 'fulfilled' } | { error: unknown; kind: 'rejected' }> =
        aggregate.client
          .callTool({ name: 'remote.slow', arguments: {} }, { signal: controller.signal })
          .then(
            () => ({ kind: 'fulfilled' }),
            (error: unknown) => ({ error, kind: 'rejected' }),
          );
      await waitFor(() => remote.slowStarted() === 1);
      controller.abort(new Error('Cancel fixture request'));
      const cancellationResult = await cancellation;
      expect(cancellationResult.kind).toBe('rejected');
      await waitFor(() => remote.slowCancelled() === 1);

      const toolChanges = aggregate.listChanges.tools;
      remote.toolsChanged();
      await waitFor(() => aggregate.listChanges.tools > toolChanges);
      const changedTools = await aggregate.client.listTools(undefined, {
        cacheMode: 'refresh',
      });
      expect(changedTools.tools.map((tool) => tool.name)).toContain('remote.dynamic');

      const createdTask = createdTaskSchema.parse(
        aggregate.taskResult(
          await aggregate.client.callTool({
            name: 'remote.start-task',
            arguments: {},
          }),
        ),
      );
      expect(createdTask.taskId).toMatch(/^toolhome-task:remote:/);
      const task = taskSchema.parse(
        await aggregate.tasks.request(
          { method: 'tasks/get', params: { taskId: createdTask.taskId } },
          { timeout: 10_000, maxTotalTimeout: 10_000 },
        ),
      );
      expect(task.taskId).toBe(createdTask.taskId);
      expect(task.status).toBe('completed');
      expect(task).toMatchObject({
        result: {
          content: [{ uri: remoteData.uri }],
        },
      });
      await aggregate.tasks.request(
        {
          method: 'tasks/update',
          params: { taskId: createdTask.taskId, ttlMs: 120_000 },
        },
        { timeout: 10_000, maxTotalTimeout: 10_000 },
      );
      await aggregate.tasks.request(
        { method: 'tasks/cancel', params: { taskId: createdTask.taskId } },
        { timeout: 10_000, maxTotalTimeout: 10_000 },
      );
      const cancelled = taskSchema.parse(
        await aggregate.tasks.request(
          { method: 'tasks/get', params: { taskId: createdTask.taskId } },
          { timeout: 10_000, maxTotalTimeout: 10_000 },
        ),
      );
      expect(cancelled.status).toBe('cancelled');

      const subscription = await aggregate.client.listen({
        resourceSubscriptions: [remoteData.uri],
      });
      remote.resourceUpdated('fixture://data');
      await waitFor(() => aggregate.resourceUpdates.includes(remoteData.uri));
      await subscription.close();

      const legacyHarness = await connectTestClient(
        new URL('/mcp', testRuntime.runtime.config.publicUrl),
        access.secret,
        appFetch,
        '2025-06-18',
      );
      clients.push(legacyHarness);
      await legacyHarness.client.setLoggingLevel('debug');
      for (const interaction of [
        { name: 'remote.confirm', source: 'modern-mrtr' },
        { name: 'home.confirm', source: 'legacy-push' },
        { name: 'remote.roots', source: 'modern-mrtr' },
        { name: 'home.roots', source: 'legacy-push' },
        { name: 'remote.sample', source: 'modern-mrtr' },
        { name: 'home.sample', source: 'legacy-push' },
      ]) {
        const result = structuredResult(
          await legacyHarness.client.callTool({
            name: interaction.name,
            arguments: {},
          }),
        );
        expect(result.source).toBe(interaction.source);
      }
      const clientExtension = structuredResult(
        await legacyHarness.client.callTool({
          name: 'home.client-extension',
          arguments: {},
        }),
      );
      expect(legacyHarness.clientRequests).toContain('toolhome/home/fixture/client-resource');
      expect(clientExtension).toMatchObject({
        result: {
          received: {
            content: [{ uri: 'toolhome://home/resource/fixture%3A%2F%2Fdata' }],
          },
        },
        source: 'legacy-client-extension',
      });

      const individual = await connectTestClient(
        new URL('/mcp/remote', testRuntime.runtime.config.publicUrl),
        access.secret,
        appFetch,
      );
      clients.push(individual);
      expect((await individual.client.listTools()).tools.map((tool) => tool.name)).toContain(
        'echo',
      );
      expect((await individual.client.listResources()).resources.map((item) => item.uri)).toEqual(
        expect.arrayContaining(['fixture://data', 'ui://fixture/dashboard']),
      );
      const individualTask = createdTaskSchema.parse(
        individual.taskResult(
          await individual.client.callTool({ name: 'start-task', arguments: {} }),
        ),
      );
      expect(individualTask.taskId).toMatch(/^task-/);
      const individualTaskState = taskSchema.parse(
        await individual.tasks.request(
          { method: 'tasks/get', params: { taskId: individualTask.taskId } },
          { timeout: 10_000, maxTotalTimeout: 10_000 },
        ),
      );
      expect(individualTaskState.taskId).toBe(individualTask.taskId);
    } finally {
      for (const client of clients.reverse()) await client.close().catch(() => undefined);
      await testRuntime.close();
      await remote.close();
    }
  }, 60_000);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
