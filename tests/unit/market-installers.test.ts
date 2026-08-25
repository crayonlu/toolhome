import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  installerForEntry,
  installArtifact,
  type InstallerContext,
} from '../../src/market/installers.js';
import type { MarketEntry } from '../../src/market/catalog.js';

const execFileAsync = promisify(execFile);

function createContext(results: number[] = [0]): { context: InstallerContext; calls: string[][] } {
  const calls: string[][] = [];
  let index = 0;
  return {
    calls,
    context: {
      marketDir: '/data/market',
      uvEnv: { UV_TOOL_BIN_DIR: '/data/.uv/tools/bin' },
      update: () => undefined,
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        return { code: results[index++] ?? 0, output: '' };
      },
    },
  };
}

describe('Market installer backends', () => {
  it('uses the Go installer backend without exposing Go as a product kind', async () => {
    const { context, calls } = createContext();
    const runtime = await installArtifact(
      {
        type: 'go',
        module: 'github.com/example/tool/cmd/tool',
        version: 'v1.2.3',
        bin: 'tool',
      },
      context,
    );
    expect(calls).toEqual([['go', 'install', 'github.com/example/tool/cmd/tool@v1.2.3']]);
    expect(runtime).toMatchObject({
      command: '/data/market/go/bin/tool',
      executionMode: 'host',
      entrypoint: null,
    });
  });

  it('uses a pinned npm installer and returns the installed binary path', async () => {
    const { context, calls } = createContext();
    const runtime = await installArtifact(
      { type: 'npm', package: '@example/tool', version: '1.2.3', bin: 'example-tool' },
      context,
    );
    expect(calls).toEqual([
      [
        'npm',
        'install',
        '--prefix',
        '/data/market',
        '--no-audit',
        '--no-fund',
        '@example/tool@1.2.3',
      ],
    ]);
    expect(runtime.command).toBe('/data/market/node_modules/.bin/example-tool');
  });

  it('uses the uv tool binary installed into the isolated tool directory', async () => {
    const { context, calls } = createContext();
    const runtime = await installArtifact(
      {
        type: 'uvx',
        package: 'mcp-server-fetch',
        bin: 'mcp-server-fetch',
        version: '2026.7.10',
        with: ['mcp<2'],
      },
      context,
    );
    expect(calls).toEqual([
      ['uv', 'tool', 'install', 'mcp-server-fetch==2026.7.10', '--with', 'mcp<2'],
    ]);
    expect(runtime).toEqual({
      command: '/data/.uv/tools/bin/mcp-server-fetch',
      executionMode: 'host',
      entrypoint: null,
    });
  });

  it('pulls a Docker installer and returns a sibling-container runtime', async () => {
    const { context, calls } = createContext([1, 0]);
    const runtime = await installArtifact(
      { type: 'docker', image: 'ghcr.io/example/tool:1.2.3', entrypoint: 'tool' },
      context,
    );
    expect(calls).toEqual([
      ['docker', 'image', 'inspect', 'ghcr.io/example/tool:1.2.3'],
      ['docker', 'pull', 'ghcr.io/example/tool:1.2.3'],
    ]);
    expect(runtime).toEqual({
      command: 'ghcr.io/example/tool:1.2.3',
      executionMode: 'docker',
      entrypoint: 'tool',
    });
  });

  it('maps legacy catalog kinds to installer backends during migration', () => {
    const legacy = {
      id: 'legacy',
      name: 'Legacy',
      description: 'Legacy',
      category: 'devtools',
      kind: 'home-stdio',
      package: 'legacy-package',
      bin: 'legacy-bin',
      version: '1.0.0',
      credential: { type: 'env' },
      requires: [],
    } satisfies MarketEntry;
    expect(installerForEntry(legacy)).toEqual({
      type: 'npm',
      package: 'legacy-package',
      bin: 'legacy-bin',
      version: '1.0.0',
    });
  });

  it('uses a declarative installer recipe without exposing its backend as the product kind', () => {
    const platformCli = {
      id: 'terraform-cli',
      name: 'Terraform CLI',
      description: 'Manage Terraform Cloud resources',
      category: 'infra',
      plane: 'cli',
      kind: 'cli-binary',
      credential: { type: 'env' },
      requires: [],
      installer: {
        type: 'go',
        module: 'github.com/hashicorp/terraform',
        version: 'v1.13.0',
        bin: 'terraform',
      },
    } satisfies MarketEntry;
    expect(installerForEntry(platformCli)).toEqual(platformCli.installer);
  });

  it('downloads and extracts a pinned GitHub Release asset into the market bin directory', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'toolhome-market-release-'));
    const archive = join(directory, 'tool.tar.gz');
    const archiveDir = join(directory, 'archive');
    mkdirSync(archiveDir);
    writeFileSync(join(archiveDir, 'platform-tool'), '#!/bin/sh\nexit 0\n');
    await execFileAsync('tar', ['-czf', archive, '-C', archiveDir, 'platform-tool']);
    const { context, calls } = createContext();
    const marketDir = join(directory, 'market');
    const runtime = await installArtifact(
      {
        type: 'github-release',
        repository: 'example/platform-tool',
        tag: 'v1.2.3',
        asset: 'tool.tar.gz',
        bin: 'platform-tool',
        archive: 'tar.gz',
        url: 'https://github.com/example/platform-tool/releases/download/v1.2.3/tool.tar.gz',
      },
      {
        ...context,
        marketDir,
        runCommand: async (command, args) => {
          calls.push([command, ...args]);
          if (command === 'curl') {
            writeFileSync(args[args.indexOf('-o') + 1]!, readFileSync(archive));
          } else if (command === 'tar' || command === 'cp') {
            await execFileAsync(command, args);
          }
          return { code: 0, output: '' };
        },
      },
    );
    expect(runtime).toMatchObject({
      command: `${marketDir}/bin/platform-tool`,
      executionMode: 'host',
      entrypoint: null,
    });
    expect(calls[0]?.slice(0, 2)).toEqual(['curl', '-fsSL']);
    rmSync(directory, { recursive: true, force: true });
  });
});
