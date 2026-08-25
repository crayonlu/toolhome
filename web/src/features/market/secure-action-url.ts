export function toConsoleActionUrl(actionUrl: string, consoleOrigin: string): string {
  const action = new URL(actionUrl);
  const origin = new URL(consoleOrigin);
  return new URL(`${action.pathname}${action.search}`, origin).toString();
}
