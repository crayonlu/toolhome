import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...args], {
      env: { ...process.env, TOOLHOME_CONFIG: '/nonexistent/toolhome-config.json' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('mcp stdio tool mode', () => {
  it('documents --tool-mode with the full and compact choices', async () => {
    const result = await runCli(['mcp', 'stdio', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('--tool-mode');
    expect(result.stdout).toContain('compact');
    expect(result.stdout).toContain('full');
  });

  it('rejects an unknown tool mode before starting the gateway', async () => {
    const result = await runCli(['mcp', 'stdio', '--tool-mode', 'individual']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('tool-mode');
  });
});
