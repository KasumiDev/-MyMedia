import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateDownloadDirectory, validateRequest } from '../src/validation.js';

describe('request validation', () => {
  it('accepts nested relative download directories and rejects traversal', () => {
    expect(validateDownloadDirectory('Media/Fansly')).toBe(`Media${path.sep}Fansly`);
    expect(() => validateDownloadDirectory('../outside')).toThrow();
    expect(() => validateDownloadDirectory('C:/outside')).toThrow();
  });
  it('accepts a signed Fansly HLS job without altering its URL', () => {
    const request = validateRequest({
      type: 'download.start',
      requestId: 'request-1',
      job: {
        jobId: 'job-1',
        manifestUrl: 'https://cdn3.fansly.com/path/stream.m3u8?Policy=secret',
        downloadDirectory: 'Fansly MyMedia',
        outputFilename: '2026-09-02_123.mp4',
        originalFilename: 'original.mp4',
        createdAt: 1,
        likeCount: 2,
        price: 300,
        debug: true,
        userAgent: 'Example Browser/1.0',
        cloudFrontAuth: {
          keyPairId: 'key-id',
          policy: 'policy-value',
          signature: 'signature-value',
        },
      },
    });

    expect(request.type).toBe('download.start');
    if (request.type === 'download.start') {
      expect(request.job.manifestUrl).toContain('Policy=secret');
      expect(request.job.debug).toBe(true);
      expect(request.job.userAgent).toBe('Example Browser/1.0');
      expect(request.job.cloudFrontAuth?.keyPairId).toBe('key-id');
    }
  });

  it('rejects a non-boolean debug value', () => {
    expect(() =>
      validateRequest({
        type: 'download.start',
        requestId: 'request-1',
        job: {
          jobId: 'job-1',
          manifestUrl: 'https://cdn3.fansly.com/path/stream.mpd',
          downloadDirectory: 'Fansly MyMedia',
          outputFilename: 'video.mp4',
          originalFilename: 'video.mp4',
          createdAt: 1,
          likeCount: 0,
          price: 0,
          userAgent: 'Example Browser/1.0',
          debug: 'yes',
        },
      }),
    ).toThrow();
  });

  it('rejects header injection through the user agent', () => {
    expect(() =>
      validateRequest({
        type: 'download.start',
        requestId: 'request-1',
        job: {
          jobId: 'job-1',
          manifestUrl: 'https://cdn3.fansly.com/path/stream.mpd',
          downloadDirectory: 'Fansly MyMedia',
          outputFilename: 'video.mp4',
          originalFilename: 'video.mp4',
          createdAt: 1,
          likeCount: 0,
          price: 0,
          userAgent: 'Browser/1.0\r\nCookie: injected',
        },
      }),
    ).toThrow();
  });

  it('rejects header injection through CloudFront authorization', () => {
    expect(() =>
      validateRequest({
        type: 'download.start',
        requestId: 'request-1',
        job: {
          jobId: 'job-1',
          manifestUrl: 'https://cdn3.fansly.com/path/stream.mpd',
          downloadDirectory: 'Fansly MyMedia',
          outputFilename: 'video.mp4',
          originalFilename: 'video.mp4',
          createdAt: 1,
          likeCount: 0,
          price: 0,
          cloudFrontAuth: {
            keyPairId: 'key-id',
            policy: 'policy-value; Cookie=bad',
            signature: 'signature-value',
          },
          userAgent: 'Example Browser/1.0',
        },
      }),
    ).toThrow();
  });

  it.each([
    'http://cdn3.fansly.com/path/stream.m3u8',
    'https://fansly.example/path/stream.m3u8',
    'https://cdn3.fansly.com/path/video.mp4',
  ])('rejects manifest URL %s', (manifestUrl) => {
    expect(() =>
      validateRequest({
        type: 'download.start',
        requestId: 'request-1',
        job: {
          jobId: 'job-1',
          manifestUrl,
          downloadDirectory: 'Fansly MyMedia',
          outputFilename: 'video.mp4',
          originalFilename: 'video.mp4',
          createdAt: 1,
          likeCount: 0,
          price: 0,
          userAgent: 'Example Browser/1.0',
        },
      }),
    ).toThrow();
  });

  it.each(['../video.mp4', 'folder\\video.mp4', 'CON.mp4', 'video.webm']) (
    'rejects unsafe output filename %s',
    (outputFilename) => {
      expect(() =>
        validateRequest({
          type: 'download.start',
          requestId: 'request-1',
          job: {
            jobId: 'job-1',
            manifestUrl: 'https://cdn3.fansly.com/path/stream.mpd',
            downloadDirectory: 'Fansly MyMedia',
            outputFilename,
            originalFilename: 'video.mp4',
            createdAt: 1,
            likeCount: 0,
            price: 0,
            userAgent: 'Example Browser/1.0',
          },
        }),
      ).toThrow();
    },
  );

  it('rejects a download job without the browser user agent', () => {
    expect(() =>
      validateRequest({
        type: 'download.start',
        requestId: 'request-1',
        job: {
          jobId: 'job-1',
          manifestUrl: 'https://cdn3.fansly.com/path/stream.mpd',
          downloadDirectory: 'Fansly MyMedia',
          outputFilename: 'video.mp4',
          originalFilename: 'video.mp4',
          createdAt: 1,
          likeCount: 0,
          price: 0,
        },
      }),
    ).toThrow('userAgent must be a non-empty string');
  });
});
