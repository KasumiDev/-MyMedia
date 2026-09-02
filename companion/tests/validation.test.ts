import { describe, expect, it } from 'vitest';

import { validateRequest } from '../src/validation.js';

describe('request validation', () => {
  it('accepts a signed Fansly HLS job without altering its URL', () => {
    const request = validateRequest({
      type: 'download.start',
      requestId: 'request-1',
      job: {
        jobId: 'job-1',
        manifestUrl: 'https://cdn3.fansly.com/path/stream.m3u8?Policy=secret',
        outputFilename: '2026-09-02_123.mp4',
        originalFilename: 'original.mp4',
        createdAt: 1,
        likeCount: 2,
        price: 300,
      },
    });

    expect(request.type).toBe('download.start');
    if (request.type === 'download.start') {
      expect(request.job.manifestUrl).toContain('Policy=secret');
    }
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
          outputFilename: 'video.mp4',
          originalFilename: 'video.mp4',
          createdAt: 1,
          likeCount: 0,
          price: 0,
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
            outputFilename,
            originalFilename: 'video.mp4',
            createdAt: 1,
            likeCount: 0,
            price: 0,
          },
        }),
      ).toThrow();
    },
  );
});
