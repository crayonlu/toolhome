import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectHarnessServers,
  resolveHarnessFiles,
  runHarnessImport,
  type HarnessImportDeps,
} from '../../src/cli/harness.js';
import { describePath } from '../../src/config/harness-formats.js';

function temporaryDirectory(): { directory: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), 'toolhome-harness-'));
  return { directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

function fakeClient(calls: RecordedCall[]) {
  return {
    async request(method: string, path: string, body?: unknown): Promise<unknown> {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      if (path === '/api/v1/config/import-harness') {
        const request = body as { preview?: boolean; node?: string };
        return {
          preview: request.preview === true,
          nodeId: request.node ?? null,
          gateways: [
            {
              name: 'gateway',
              slug: 'gateway',
              via: 'stdio',
              target: null,
              message: 'local gateway',
            },
          ],
          entries: [
            {
              name: 'docs',
              slug: 'docs',
              kind: 'remote',
              nodeId: null,
              transportSummary: 'https://docs.example.test/mcp',
              status: request.preview === true ? 'created' : 'created',
              changes: [],
              warnings: [],
              credential: null,
            },
          ],
        };
      }
      if (path === '/api/v1/access-keys') {
        return { key: { id: 'key-1', name: 'laptop' }, secret: 'tch_mcp_issued' };
      }
      if (path === '/api/v1/diagnostics') {
        return {
          ok: false,
          servers: [
            { slug: 'docs', enabled: true, status: 'unreachable' },
            { slug: 'local-chrome', enabled: true, status: 'unknown' },
          ],
        };
      }
      throw new Error(`unexpected call ${method} ${path}`);
    },
  };
}

function depsFor(directory: string, calls: RecordedCall[], log: string[] = []): HarnessImportDeps {
  return {
    client: fakeClient(calls),
    baseUrl: 'https://tool.example.test',
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, text) => {
      writeFileSync(path, text, { mode: 0o600 });
      chmodSync(path, 0o600);
    },
    backup: (path) => {
      const target = `${path}.bak-test`;
      writeFileSync(target, readFileSync(path, 'utf8'));
      return target;
    },
    env: {},
    home: directory,
    log: (line) => log.push(line),
  };
}

const jsonConfig = {
  mcpServers: {
    docs: { url: 'https://docs.example.test/mcp' },
    gateway: { command: 'toolhome', args: ['mcp', 'stdio'] },
    keepme: { command: 'node', args: ['/opt/keepme/index.js'] },
  },
};

describe('harness import flow', () => {
  it('previews without writing and reports the gateway entry', async () => {
    const { directory, cleanup } = temporaryDirectory();
    try {
      const path = join(directory, 'mcp.json');
      writeFileSync(path, `${JSON.stringify(jsonConfig, null, 2)}\n`);
      const calls: RecordedCall[] = [];
      const report = await runHarnessImport(depsFor(directory, calls), {
        files: [path],
        harnesses: [],
        preview: true,
        writeBack: false,
        mode: 'create',
      });

      expect(report.applied).toBe(false);
      expect(report.gateways.map((gateway) => gateway.slug)).toEqual(['gateway']);
      expect(report.entries.map((entry) => entry.slug)).toEqual(['docs']);
      expect(report.accessKey).toBeNull();
      expect(report.writtenBack).toEqual([]);
      // Only the preview call reached the server.
      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        'POST /api/v1/config/import-harness',
      ]);
      expect((calls[0]?.body as { preview?: boolean }).preview).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(jsonConfig, null, 2)}\n`);
    } finally {
      cleanup();
    }
  });

  it('applies, verifies, issues an Access Key and rewrites the harness file', async () => {
    const { directory, cleanup } = temporaryDirectory();
    try {
      const path = join(directory, 'mcp.json');
      writeFileSync(path, `${JSON.stringify(jsonConfig, null, 2)}\n`);
      const calls: RecordedCall[] = [];
      const log: string[] = [];
      const report = await runHarnessImport(depsFor(directory, calls, log), {
        files: [path],
        harnesses: [],
        nodeId: 'R9000P',
        preview: false,
        writeBack: true,
        issueAccessKey: 'laptop',
        mode: 'create',
      });

      expect(report.applied).toBe(true);
      expect(report.verification.ok).toBe(false);
      // Only host-hosted servers that are not ready are named.
      expect(report.verification.failing).toEqual(['docs']);
      expect(report.accessKey?.snippet).toContain('https://tool.example.test/mcp');
      expect(report.accessKey?.snippet).toContain('tch_mcp_issued');
      expect(report.accessKey?.snippetToml).toContain('[mcp_servers.toolhome]');
      expect(report.accessKey?.snippet).not.toContain('[object Object]');

      // Placement travels in the apply body.
      const apply = calls.find(
        (call) =>
          call.path === '/api/v1/config/import-harness' &&
          (call.body as { preview?: boolean }).preview !== true,
      );
      expect(apply?.body).toMatchObject({ node: 'R9000P' });

      // The migrated entries are gone; the untouchable one and the new entry remain.
      const written = JSON.parse(readFileSync(path, 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(Object.keys(written.mcpServers).sort()).toEqual(['keepme', 'toolhome']);
      expect(written.mcpServers.toolhome).toEqual({
        url: 'https://tool.example.test/mcp',
        headers: { Authorization: 'Bearer tch_mcp_issued' },
      });
      expect(readdirSync(directory).some((name) => name.endsWith('.bak-test'))).toBe(true);
      expect(log.join('\n')).toContain('applying the import');
    } finally {
      cleanup();
    }
  });

  it('rewrites a TOML harness without touching its other sections', async () => {
    const { directory, cleanup } = temporaryDirectory();
    try {
      const path = join(directory, 'config.toml');
      writeFileSync(
        path,
        `[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n\n[mcp_servers.gateway]\ncommand = "toolhome"\nargs = ["mcp", "stdio"]\n\n[ui]\ntheme = "terminal"\n`,
      );
      const report = await runHarnessImport(depsFor(directory, []), {
        files: [path],
        harnesses: [],
        preview: false,
        writeBack: true,
        issueAccessKey: 'laptop',
        mode: 'upsert',
      });

      const written = readFileSync(path, 'utf8');
      expect(written).toContain('[ui]\ntheme = "terminal"');
      expect(written).not.toContain('[mcp_servers.docs]');
      expect(written).not.toContain('[mcp_servers.gateway]');
      expect(written).toContain('[mcp_servers.toolhome]');
      expect(written).toContain('Authorization = "Bearer tch_mcp_issued"');
      expect(report.writtenBack[0]?.path).toBe(path);
    } finally {
      cleanup();
    }
  });

  it('refuses to write back without an Access Key for the new entry', async () => {
    const { directory, cleanup } = temporaryDirectory();
    try {
      const path = join(directory, 'mcp.json');
      writeFileSync(path, `${JSON.stringify(jsonConfig)}\n`);
      await expect(
        runHarnessImport(depsFor(directory, []), {
          files: [path],
          harnesses: [],
          preview: false,
          writeBack: true,
          mode: 'create',
        }),
      ).rejects.toThrow(/--issue-access-key/);
    } finally {
      cleanup();
    }
  });

  it('finds a harness through its known location and env override', async () => {
    const { directory, cleanup } = temporaryDirectory();
    try {
      const path = join(directory, 'config.toml');
      writeFileSync(path, `[mcp_servers.docs]\nurl = "https://docs.example.test/mcp"\n`);
      const targets = resolveHarnessFiles(
        { files: [], harnesses: ['grok'] },
        { GROK_HOME: directory },
        '/nonexistent',
      );
      expect(targets).toEqual([{ path, format: 'toml', key: 'mcp_servers' }]);

      const { servers, warnings } = collectHarnessServers(targets, {
        readFile: (file) => readFileSync(file, 'utf8'),
      });
      expect(servers).toEqual({ docs: { url: 'https://docs.example.test/mcp' } });
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('warns when two files define the same server differently, first one winning', () => {
    const { directory, cleanup } = temporaryDirectory();
    try {
      const first = join(directory, 'a.json');
      const second = join(directory, 'b.json');
      writeFileSync(first, JSON.stringify({ mcpServers: { docs: { url: 'https://a.test/mcp' } } }));
      writeFileSync(
        second,
        JSON.stringify({ mcpServers: { docs: { url: 'https://b.test/mcp' } } }),
      );
      const { servers, warnings } = collectHarnessServers(
        [describePath(first, ''), describePath(second, '')],
        { readFile: (file) => readFileSync(file, 'utf8') },
      );
      expect(servers.docs).toEqual({ url: 'https://a.test/mcp' });
      expect(warnings.join(' ')).toContain('defined differently');
    } finally {
      cleanup();
    }
  });
});
