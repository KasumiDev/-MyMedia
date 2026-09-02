import { describe, expect, it } from 'vitest';

import { chooseBestStreams, parseProgressBlock } from '../src/media.js';

describe('media selection', () => {
  it('chooses highest resolution and then highest bitrate', () => {
    expect(
      chooseBestStreams({
        streams: [
          { index: 1, codec_type: 'video', width: 1920, height: 1080, bit_rate: '3000000' },
          { index: 2, codec_type: 'video', width: 1920, height: 1080, bit_rate: '6000000' },
          { index: 3, codec_type: 'audio', bit_rate: '128000' },
          { index: 4, codec_type: 'audio', bit_rate: '256000' },
        ],
        format: { duration: '10.5' },
      }),
    ).toEqual({ videoIndex: 2, audioIndex: 4, durationMs: 10_500 });
  });

  it('parses FFmpeg progress without exceeding 100 percent', () => {
    expect(
      parseProgressBlock('out_time_ms=12000000\ntotal_size=42\nspeed=2.5x\nprogress=continue\n', 10_000),
    ).toEqual({ outTimeMs: 12_000, totalSize: 42, speed: 2.5, percent: 100 });
  });
});
