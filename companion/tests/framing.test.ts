import { describe, expect, it } from 'vitest';

import { encodeNativeMessage, NativeMessageDecoder } from '../src/framing.js';

describe('native message framing', () => {
  it('decodes fragmented and adjacent frames', () => {
    const first = encodeNativeMessage({ type: 'hello', requestId: 'one' });
    const second = encodeNativeMessage({ type: 'hello', requestId: 'two' });
    const bytes = Buffer.concat([first, second]);
    const decoder = new NativeMessageDecoder();

    expect(decoder.push(bytes.subarray(0, 7))).toEqual([]);
    expect(decoder.push(bytes.subarray(7))).toEqual([
      { type: 'hello', requestId: 'one' },
      { type: 'hello', requestId: 'two' },
    ]);
  });
});
