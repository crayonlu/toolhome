export function parseArgvText(value: string): string[] {
  return value
    .split('\n')
    .map((argument) => argument.trim())
    .filter((argument) => argument.length > 0);
}
