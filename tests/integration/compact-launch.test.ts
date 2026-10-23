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
    'completes handshake and find → describe → exec on three consecutive clean launches',
    { timeout: 300_000 },
    async () => {
      const logFile = process.env.TOOLHOME_LAUNCH_LOG;
      for (let run = 1; run <= 3; run += 1) {
        // runCompactLaunch creates a unique scratch dir per call, so every run
        // starts without a mirror, lock, or session from the previous launch.
        const report = await runCompactLaunch({
          mode: 'compact',
          ...(logFile === undefined ? {} : { logFile }),
        });
        verifyCompactLaunch(report);
        expect(report.host.tools, `run ${run}: host tools`).toEqual(['search', 'exec']);
        expect(report.local.tools, `run ${run}: local tools`).toEqual(['search', 'exec']);
        expect(report.host.find, `run ${run}: host find`).toBeDefined();
        expect(report.host.describe?.inputSchema, `run ${run}: host describe`).toEqual(
          report.expectedInputSchema,
        );
        expect(report.local.describe?.inputSchema, `run ${run}: local describe`).toEqual(
          report.expectedInputSchema,
        );
        expect(report.host.exec, `run ${run}: host exec`).toEqual({ value: 42 });
        expect(report.local.exec, `run ${run}: local exec`).toEqual({ value: 42 });
      }
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
