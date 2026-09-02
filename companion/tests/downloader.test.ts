import { describe, expect, it } from 'vitest';

import { buildMediaInputOptions, safeFailure } from '../src/downloader.js';

describe('media request context', () => {
  it('adds the Fansly origin, referer, and browser user agent without credentials', () => {
    const options = buildMediaInputOptions({
      userAgent: 'Example Browser/1.0',
    });
    const serialized = options.join('\n');

    expect(serialized).toContain('Origin: https://fansly.com');
    expect(serialized).toContain('https://fansly.com/');
    expect(serialized).toContain('Example Browser/1.0');
    expect(serialized.toLowerCase()).not.toContain('authorization');
    expect(serialized.toLowerCase()).not.toContain('cookie');
    expect(serialized.toLowerCase()).not.toContain('fansly-session-id');
  });

  it('forwards only the three CloudFront authorization cookies', () => {
    const options = buildMediaInputOptions({
      userAgent: 'Chrome Browser/1.0',
      cloudFrontAuth: {
        keyPairId: 'key-id',
        policy: 'policy-value',
        signature: 'signature-value',
      },
    });
    const serialized = options.join('\n');

    expect(serialized).toContain('CloudFront-Key-Pair-Id=key-id');
    expect(serialized).toContain('CloudFront-Policy=policy-value');
    expect(serialized).toContain('CloudFront-Signature=signature-value');
    expect(serialized).not.toContain('fansly-d');
    expect(serialized).not.toContain('intercom');
  });

  it('classifies rejected CDN authorization without exposing diagnostics', () => {
    expect(safeFailure(new Error('HTTP error 403 Forbidden at a signed URL'))).toBe(
      'CDN_AUTHORIZATION_FAILED: CloudFront authorization expired or was rejected.',
    );
  });
});
