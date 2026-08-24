interface OperationOptions {
  body?: boolean;
  parameters?: Record<string, unknown>[];
  security?: Record<string, string[]>[];
  success?: 200 | 201;
  summary: string;
}

const jsonContent = {
  'application/json': {
    schema: { type: 'object', additionalProperties: true },
  },
};

const idParameter = (name: string): Record<string, unknown> => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
});

const limitParameter: Record<string, unknown> = {
  name: 'limit',
  in: 'query',
  schema: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
};

export function controlOpenApi(publicUrl: URL): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (
    path: string,
    method: 'get' | 'post' | 'patch' | 'delete',
    operationId: string,
    options: OperationOptions,
  ): void => {
    const operation: Record<string, unknown> = {
      operationId,
      summary: options.summary,
      responses: {
        [String(options.success ?? 200)]: {
          description: 'Success',
          content: jsonContent,
        },
        '400': { $ref: '#/components/responses/BadRequest' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { $ref: '#/components/responses/NotFound' },
        '409': { $ref: '#/components/responses/Conflict' },
      },
      security: options.security ?? [{ controlApiKey: [] }, { controlSession: [] }],
      ...(options.parameters === undefined ? {} : { parameters: options.parameters }),
      ...(options.body
        ? {
            requestBody: {
              required: true,
              content: jsonContent,
            },
          }
        : {}),
    };
    paths[path] = { ...paths[path], [method]: operation };
  };

  add('/api/v1/session', 'post', 'createControlSession', {
    summary: 'Exchange a Control API Key for a Web session',
    security: [{ controlApiKey: [] }],
  });
  add('/api/v1/session', 'delete', 'deleteControlSession', {
    summary: 'End the current Web session',
    security: [],
  });
  add('/api/v1/openapi.json', 'get', 'getControlOpenApi', {
    summary: 'Read this OpenAPI document',
  });

  add('/api/v1/servers', 'get', 'listServers', { summary: 'List MCP servers' });
  add('/api/v1/servers', 'post', 'createServer', {
    summary: 'Create an MCP server',
    body: true,
    success: 201,
  });
  add('/api/v1/servers/{server_id}', 'get', 'getServer', {
    summary: 'Get an MCP server',
    parameters: [idParameter('server_id')],
  });
  add('/api/v1/servers/{server_id}', 'patch', 'updateServer', {
    summary: 'Update an MCP server',
    parameters: [idParameter('server_id')],
    body: true,
  });
  add('/api/v1/servers/{server_id}', 'delete', 'deleteServer', {
    summary: 'Delete an MCP server',
    parameters: [idParameter('server_id')],
  });
  for (const action of ['test', 'enable', 'disable', 'refresh', 'restart']) {
    add(`/api/v1/servers/{server_id}/${action}`, 'post', `${action}Server`, {
      summary: `${capitalize(action)} an MCP server`,
      parameters: [idParameter('server_id')],
    });
  }
  for (const view of ['capabilities', 'status', 'endpoint']) {
    add(`/api/v1/servers/{server_id}/${view}`, 'get', `getServer${capitalize(view)}`, {
      summary: `Read server ${view}`,
      parameters: [idParameter('server_id')],
    });
  }
  add('/api/v1/servers/{server_id}/logs', 'get', 'getServerLogs', {
    summary: 'Read server event logs',
    parameters: [idParameter('server_id'), limitParameter],
  });
  add('/api/v1/servers/{server_id}/projection', 'get', 'getServerProjection', {
    summary: 'Read tool visibility projection for a server',
    parameters: [idParameter('server_id')],
  });
  add('/api/v1/servers/{server_id}/projection', 'patch', 'updateServerProjection', {
    summary: 'Update tool visibility projection for a server',
    parameters: [idParameter('server_id')],
    body: true,
  });

  add('/api/v1/credentials', 'get', 'listCredentials', {
    summary: 'List redacted upstream credentials',
  });
  add('/api/v1/credentials', 'post', 'createCredential', {
    summary: 'Create an encrypted upstream credential',
    body: true,
    success: 201,
  });
  add('/api/v1/credentials/{credential_id}', 'get', 'getCredential', {
    summary: 'Get a redacted upstream credential',
    parameters: [idParameter('credential_id')],
  });
  add('/api/v1/credentials/{credential_id}', 'patch', 'updateCredential', {
    summary: 'Update an upstream credential',
    parameters: [idParameter('credential_id')],
    body: true,
  });
  add('/api/v1/credentials/{credential_id}', 'delete', 'deleteCredential', {
    summary: 'Delete an upstream credential',
    parameters: [idParameter('credential_id')],
  });
  add('/api/v1/credentials/{credential_id}/test', 'post', 'testCredential', {
    summary: 'Verify a credential against attached upstream servers',
    parameters: [idParameter('credential_id')],
  });
  add('/api/v1/credentials/{credential_id}/authorize', 'post', 'authorizeCredential', {
    summary: 'Start or resume upstream OAuth authorization',
    parameters: [idParameter('credential_id')],
    body: true,
  });
  add('/api/v1/credentials/{credential_id}/revoke', 'post', 'revokeCredential', {
    summary: 'Revoke an upstream OAuth credential',
    parameters: [idParameter('credential_id')],
  });

  // ── CLI registry (Form A CLI plane) ────────────────────────────────────
  add('/api/v1/clis', 'get', 'listClis', { summary: 'List registered CLIs' });
  add('/api/v1/clis', 'post', 'createCli', {
    summary: 'Register a CLI (command or image, allow-list, probe, credential)',
    body: true,
    success: 201,
  });
  add('/api/v1/clis/{cli_id}', 'get', 'getCli', {
    summary: 'Fetch a CLI record',
    parameters: [idParameter('cli_id')],
  });
  add('/api/v1/clis/{cli_id}', 'patch', 'updateCli', {
    summary: 'Update a CLI record',
    parameters: [idParameter('cli_id')],
    body: true,
  });
  add('/api/v1/clis/{cli_id}', 'delete', 'deleteCli', {
    summary: 'Delete a CLI record',
    parameters: [idParameter('cli_id')],
  });
  add('/cli/{slug}/exec', 'post', 'execCli', {
    summary:
      'Run a CLI: argv array only (never a shell string); streams NDJSON stdout/stderr frames and a final exit frame',
    parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
    body: true,
    security: [{ controlApiKey: [] }],
  });
  add('/cli/{slug}/status', 'get', 'cliStatus', {
    summary: 'Run the CLI probe and return installed/version/loggedIn/lastCheckedAt',
    parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }],
    security: [{ controlApiKey: [] }],
  });

  for (const kind of ['control', 'access']) {
    const segment = kind === 'control' ? 'control-keys' : 'access-keys';
    const title = kind === 'control' ? 'Control API' : 'MCP Access';
    add(`/api/v1/${segment}`, 'get', `list${capitalize(kind)}Keys`, {
      summary: `List ${title} keys`,
    });
    add(`/api/v1/${segment}`, 'post', `create${capitalize(kind)}Key`, {
      summary: `Create a ${title} key`,
      body: true,
      success: 201,
    });
    add(`/api/v1/${segment}/{key_id}`, 'delete', `revoke${capitalize(kind)}Key`, {
      summary: `Revoke a ${title} key`,
      parameters: [idParameter('key_id')],
    });
  }

  add('/api/v1/overview', 'get', 'getOverview', { summary: 'Read the system overview' });
  add('/api/v1/events', 'get', 'listEvents', {
    summary: 'Read system events',
    parameters: [limitParameter],
  });
  add('/api/v1/calls', 'get', 'listCalls', {
    summary: 'List tool call records (metadata only)',
    parameters: [
      limitParameter,
      { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } },
      { name: 'server_id', in: 'query', schema: { type: 'string' } },
      { name: 'tool', in: 'query', schema: { type: 'string' } },
      {
        name: 'endpoint_type',
        in: 'query',
        schema: { type: 'string', enum: ['aggregate', 'individual', 'management'] },
      },
      { name: 'principal_id', in: 'query', schema: { type: 'string' } },
      {
        name: 'status',
        in: 'query',
        schema: {
          type: 'string',
          enum: ['success', 'tool_error', 'protocol_error', 'timeout', 'cancelled', 'rejected'],
        },
      },
      { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
  });
  add('/api/v1/calls/stats', 'get', 'getCallStats', {
    summary: 'Aggregate tool call statistics',
    parameters: [
      { name: 'server_id', in: 'query', schema: { type: 'string' } },
      { name: 'tool', in: 'query', schema: { type: 'string' } },
      { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
  });
  add('/api/v1/calls/series', 'get', 'getCallSeries', {
    summary: 'Tool call counts bucketed over time for line charts',
    parameters: [
      {
        name: 'bucket',
        in: 'query',
        schema: { type: 'string', description: 'e.g. 30m, 1h, 6h, 1d (default 1h)' },
      },
      { name: 'server_id', in: 'query', schema: { type: 'string' } },
      { name: 'tool', in: 'query', schema: { type: 'string' } },
      { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
  });
  add('/api/v1/diagnostics', 'get', 'getDiagnostics', {
    summary: 'Read system diagnostics',
  });
  add('/api/v1/config/export', 'get', 'exportConfig', {
    summary: 'Export configuration or a restorable secret backup',
    parameters: [
      {
        name: 'includeSecrets',
        in: 'query',
        schema: { type: 'boolean', default: false },
      },
    ],
  });
  add('/api/v1/config/import', 'post', 'importConfig', {
    summary: 'Atomically import a restorable configuration backup (admin)',
    body: true,
  });
  add('/api/v1/config/import-harness', 'post', 'importHarnessConfig', {
    summary:
      'Import a harness mcpServers config (Claude Desktop / Cursor JSON); secrets become encrypted credentials (admin)',
    body: true,
  });
  add('/api/v1/endpoints/aggregate', 'get', 'getAggregateEndpoint', {
    summary: 'Read the aggregate MCP endpoint',
  });
  add('/api/v1/market', 'get', 'listMarket', {
    summary: 'List the curated market catalog with install state',
  });
  add('/api/v1/market/updates', 'get', 'listMarketUpdates', {
    summary: 'Compare installed versions against catalog pins (plus best-effort upstream latest)',
  });
  add('/api/v1/market/{entry_id}/update', 'post', 'updateMarketEntry', {
    summary:
      'Explicitly update an installed entry to the catalog pin; keeps credential and visibility, restarts the server',
    parameters: [{ name: 'entry_id', in: 'path', required: true, schema: { type: 'string' } }],
  });
  add('/api/v1/market/installations', 'get', 'listMarketInstallations', {
    summary: 'List recorded market installs (source, version, recipe)',
  });
  add('/api/v1/market/install/{job_id}', 'get', 'getMarketInstallJob', {
    summary: 'Read an async market install job',
    parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' } }],
  });
  add('/api/v1/market/{entry_id}/install', 'post', 'installMarketEntry', {
    summary: 'Install a curated entry; returns a one-time action URL when a secret is required',
    parameters: [{ name: 'entry_id', in: 'path', required: true, schema: { type: 'string' } }],
    body: true,
  });
  add('/api/v1/market/{entry_id}/uninstall', 'post', 'uninstallMarketEntry', {
    summary: 'Uninstall a curated entry (admin)',
    parameters: [{ name: 'entry_id', in: 'path', required: true, schema: { type: 'string' } }],
  });
  add('/api/v1/secure-actions/{action_id}', 'get', 'getSecureAction', {
    summary: 'Read a pending secure action and its required secret fields',
    parameters: [{ name: 'action_id', in: 'path', required: true, schema: { type: 'string' } }],
  });
  add('/api/v1/secure-actions/{action_id}/complete', 'post', 'completeSecureAction', {
    summary: 'Complete a one-time secure action, storing secrets and resuming the install',
    parameters: [{ name: 'action_id', in: 'path', required: true, schema: { type: 'string' } }],
    body: true,
  });
  add('/api/v1/control-keys', 'post', 'createControlKey', {
    summary: 'Create a control key with an admin or agent scope',
    body: true,
  });

  return {
    openapi: '3.1.0',
    info: {
      title: 'ToolHome Control API',
      version: '0.1.0',
      description: 'Complete single-user management API for ToolHome.',
    },
    servers: [{ url: publicUrl.toString().replace(/\/$/, '') }],
    paths,
    components: {
      securitySchemes: {
        controlApiKey: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'mch_ctl_',
        },
        controlSession: {
          type: 'apiKey',
          in: 'cookie',
          name: 'mcp_home_session',
        },
      },
      responses: {
        BadRequest: problemResponse('Request validation failed'),
        Unauthorized: problemResponse('Control credential required'),
        NotFound: problemResponse('Resource not found'),
        Conflict: problemResponse('Resource conflict'),
      },
    },
  };
}

function problemResponse(description: string): Record<string, unknown> {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                detail: {},
              },
            },
          },
        },
      },
    },
  };
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
