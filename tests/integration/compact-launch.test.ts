import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCompactLaunch, verifyCompactLaunch } from '../../scripts/compact-launch.js';

const distService = fileURLToPath(new URL('../../dist/server/main.js', import.meta.url));
const distCli = fileURLToPath(new URL('../../dist/server/cli/main.js', import.meta.url));
// The parent builds before running; skip cleanly when dist is absent (e.g. a bare `npm test`).
const built = existsSync(distService) && existsSync(distCli);

describe.skipIf(!built)('compact launch over built processes', () => {
  it(
    'serves search/exec on the built host and the built CLI local stdio in compact mode',
    { timeout: 180_000 },
    async () => {
      const report = await runCompactLaunch({ mode: 'compact' });
      verifyCompactLaunch(report);
      expect(report.host.tools).toEqual(['search', 'exec']);
      expect(report.local.tools).toEqual(['search', 'exec']);
      expect(report.local.exec).toEqual({ value: 42 });
      expect(report.local.mixed?.structuredContent).toEqual({ value: 7 });
      expect(report.local.describe?.inputSchema).toEqual(report.expectedInputSchema);
    },
  );

  it(
    'exposes native fixture tools on the built host and the built CLI local stdio in full mode',
    { timeout: 180_000 },
    async () => {
      const report = await runCompactLaunch({ mode: 'full' });
      verifyCompactLaunch(report);
      expect(report.host.tools).toContain(report.hostToolId);
      expect(report.local.tools).toContain(report.localToolId);
      expect(report.local.native).toEqual({ value: 42 });
    },
  );
});
