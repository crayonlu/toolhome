/**
 * CLI status probe parsing (docs/cli-hosting-research.md §2.6).
 *
 * The probe command's stdout is key=value on each line; `version` surfaces as
 * the version string and `loggedIn`/`logged_in` as the boolean login state.
 * Absent keys keep their defaults.
 */
export function parseProbeOutput(stdout: string): { version: string | null; loggedIn: boolean } {
  let version: string | null = null;
  let loggedIn = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    const versionMatch = /^version=(.*)$/.exec(trimmed);
    if (versionMatch?.[1] !== undefined && versionMatch[1] !== '') {
      version = versionMatch[1];
    }
    const loginMatch =
      /^loggedIn=(true|false)$/i.exec(trimmed) ?? /^logged_in=(true|false)$/i.exec(trimmed);
    if (loginMatch?.[1] !== undefined) {
      loggedIn = loginMatch[1].toLowerCase() === 'true';
    }
  }
  return { version, loggedIn };
}
