import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDiagnosticLogger, redactDiagnostic } from '../src/logger.js';

describe('diagnostic logging', () => {
  it('redacts signed URLs and sensitive fields', () => {
    const diagnostic = redactDiagnostic(
      'Failed https://cdn3.fansly.com/stream.m3u8?Policy=secret&Signature=value authorization: bearer-token',
    );

    expect(diagnostic).not.toContain('secret');
    expect(diagnostic).not.toContain('bearer-token');
    expect(diagnostic).toContain('[redacted-url]');
    expect(diagnostic).toContain('authorization=[redacted]');
  });

  it('redacts signatures on relative manifest entries', () => {
    const diagnostic = redactDiagnostic(
      'segment.m4s?Policy=secret&Signature=value&Key-Pair-Id=key',
    );

    expect(diagnostic).not.toContain('secret');
    expect(diagnostic).not.toContain('value');
    expect(diagnostic).not.toContain('=key');
  });

  it('redacts every CloudFront cookie value from verbose HTTP output', () => {
    const diagnostic = redactDiagnostic(
      'Cookie: CloudFront-Key-Pair-Id=key-secret; CloudFront-Policy=policy-secret; CloudFront-Signature=signature-secret',
    );

    expect(diagnostic).not.toContain('key-secret');
    expect(diagnostic).not.toContain('policy-secret');
    expect(diagnostic).not.toContain('signature-secret');
  });

  it('writes JSON lines beneath LocalAppData', () => {
    const localAppData = mkdtempSync(path.join(os.tmpdir(), 'fansly-log-'));
    const logger = createDiagnosticLogger({ LOCALAPPDATA: localAppData }, localAppData);

    logger.log('download.failed', {
      jobId: 'job-1',
      error: 'https://cdn3.fansly.com/video.mpd?Signature=secret',
    });

    const entry = JSON.parse(readFileSync(logger.path, 'utf8')) as Record<string, unknown>;
    expect(entry.event).toBe('download.failed');
    expect(entry.jobId).toBe('job-1');
    expect(entry.error).toBe('[redacted-url]');
  });
});
