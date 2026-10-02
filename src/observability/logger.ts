const severity = { debug: 10, info: 20, warn: 30, error: 40 } satisfies Record<string, number>;

export type LogLevel = keyof typeof severity;

export interface Logger {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

export function createLogger(
  minimum: LogLevel,
  /**
   * Where lines go. The default sends info/debug to stdout and warn/error to
   * stderr, which suits HTTP servers. Anything that speaks a line-based protocol
   * on stdout — the local stdio gateway — must pass a sink that always writes to
   * stderr, or log lines would corrupt the protocol.
   */
  sink?: (line: string, level: LogLevel) => void,
): Logger {
  const write =
    sink ??
    ((line: string, level: LogLevel) => {
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
    });
  const emit = (level: LogLevel, message: string, detail?: Record<string, unknown>): void => {
    if (severity[level] < severity[minimum]) return;
    const entry = {
      time: new Date().toISOString(),
      level,
      message,
      ...(detail === undefined ? {} : { detail }),
    };
    write(JSON.stringify(entry), level);
  };

  return {
    debug: (message, detail) => emit('debug', message, detail),
    info: (message, detail) => emit('info', message, detail),
    warn: (message, detail) => emit('warn', message, detail),
    error: (message, detail) => emit('error', message, detail),
  };
}
