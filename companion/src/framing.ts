const HEADER_BYTES = 4;
const MAX_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength > MAX_MESSAGE_BYTES) {
    throw new Error('Native message exceeds the size limit');
  }

  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages: unknown[] = [];

    while (this.buffer.byteLength >= HEADER_BYTES) {
      const bodyLength = this.buffer.readUInt32LE(0);
      if (bodyLength > MAX_MESSAGE_BYTES) {
        throw new Error('Native message exceeds the size limit');
      }

      const frameLength = HEADER_BYTES + bodyLength;
      if (this.buffer.byteLength < frameLength) {
        break;
      }

      const body = this.buffer.subarray(HEADER_BYTES, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      messages.push(JSON.parse(body.toString('utf8')) as unknown);
    }

    return messages;
  }
}
