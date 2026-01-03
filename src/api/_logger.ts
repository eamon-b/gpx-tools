/**
 * Structured logging utility for API handlers.
 *
 * Outputs JSON-formatted logs that are compatible with Vercel's
 * logging infrastructure and can be easily parsed by log aggregators.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  context: string;
  message: string;
  timestamp: string;
  [key: string]: unknown;
}

function formatLog(level: LogLevel, context: string, message: string, extra?: Record<string, unknown>): string {
  const entry: LogEntry = {
    level,
    context,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  };
  return JSON.stringify(entry);
}

/**
 * Log an error message with context
 */
export function logError(context: string, error: unknown, extra?: Record<string, unknown>): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(formatLog('error', context, message, extra));
}

/**
 * Log a warning message with context
 */
export function logWarn(context: string, message: string, extra?: Record<string, unknown>): void {
  console.warn(formatLog('warn', context, message, extra));
}

/**
 * Log an info message with context
 */
export function logInfo(context: string, message: string, extra?: Record<string, unknown>): void {
  console.log(formatLog('info', context, message, extra));
}

/**
 * Log a debug message with context (only in development)
 */
export function logDebug(context: string, message: string, extra?: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== 'production') {
    console.log(formatLog('debug', context, message, extra));
  }
}
