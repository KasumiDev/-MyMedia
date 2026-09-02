import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_VALUE_LENGTH = 64 * 1024;
const URL_PATTERN = /https?:\/\/[^\s'"<>]+/giu;
const SECRET_PATTERN = /(authorization|cookie|fansly-session-id|policy|signature|key-pair-id)\s*[:=]\s*[^\s,;]+/giu;
const SIGNED_QUERY_PATTERN = /([?&](?:policy|signature|key-pair-id)=)[^&\s'"<>]*/giu;

export interface DiagnosticLogger {
  readonly path: string;
  log(event: string, details?: Record<string, unknown>): void;
}

export function createDiagnosticLogger(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): DiagnosticLogger {
  const localAppData = environment.LOCALAPPDATA
    ?? path.join(homeDirectory, 'AppData', 'Local');
  const logDirectory = path.join(localAppData, 'FanslyMyMedia', 'Companion', 'logs');
  const logPath = path.join(logDirectory, 'companion.log');
  const previousLogPath = path.join(logDirectory, 'companion.previous.log');

  try {
    mkdirSync(logDirectory, { recursive: true });
    rotateLog(logPath, previousLogPath);
  } catch {
    // Logging must never prevent the native host from starting.
  }

  return {
    path: logPath,
    log(event, details = {}) {
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...sanitizeDetails(details),
      });

      try {
        appendFileSync(logPath, `${entry}\n`, { encoding: 'utf8' });
      } catch {
        // Download behavior must not depend on diagnostic storage.
      }
    },
  };
}

export function redactDiagnostic(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(URL_PATTERN, '[redacted-url]')
    .replace(SECRET_PATTERN, '$1=[redacted]')
    .replace(SIGNED_QUERY_PATTERN, '$1[redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .slice(0, MAX_VALUE_LENGTH);
}

function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) => [
    key,
    typeof value === 'string' || value instanceof Error
      ? redactDiagnostic(value)
      : value,
  ]));
}

function rotateLog(logPath: string, previousLogPath: string): void {
  if (!existsSync(logPath) || statSync(logPath).size < MAX_LOG_BYTES) {
    return;
  }

  rmSync(previousLogPath, { force: true });
  renameSync(logPath, previousLogPath);
}
