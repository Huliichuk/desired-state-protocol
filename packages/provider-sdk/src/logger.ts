/**
 * Minimal structured logger contract. Kept dependency-free so providers do not
 * inherit the runtime's logging library.
 *
 * Implementations MUST redact secrets before emitting.
 */
export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void
  info(fields: Record<string, unknown>, message: string): void
  warn(fields: Record<string, unknown>, message: string): void
  error(fields: Record<string, unknown>, message: string): void
  child(fields: Record<string, unknown>): Logger
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
}
