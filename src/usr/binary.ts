/**
 * Little-endian binary reader/writer over Buffers, with the USR string
 * convention: u32 byte length followed by ASCII (1 byte/char) or UTF-16LE
 * (2 bytes/char) payload. A length of -1 encodes a null (absent) string.
 */

export class UsrParseError extends Error {
  constructor(
    message: string,
    readonly offset?: number,
  ) {
    super(offset === undefined ? message : `${message} (at byte offset ${offset})`);
    this.name = 'UsrParseError';
  }
}

export class BinaryReader {
  private off = 0;

  constructor(private readonly buf: Buffer) {}

  get offset(): number {
    return this.off;
  }

  get remaining(): number {
    return this.buf.length - this.off;
  }

  private need(n: number): void {
    if (this.off + n > this.buf.length) {
      throw new UsrParseError(`unexpected end of file, needed ${n} more bytes`, this.off);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8(this.off++);
  }

  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.off);
    this.off += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.buf.readDoubleLE(this.off);
    this.off += 8;
    return v;
  }

  bytes(n: number): Buffer {
    this.need(n);
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return v;
  }

  /** USR string; bytesPerChar 1 = ASCII, 2 = UTF-16LE. Length -1 → null. */
  string(bytesPerChar: 1 | 2): string | null {
    const len = this.i32();
    if (len === -1) {
      return null;
    }
    if (len < 0 || len > 4096) {
      throw new UsrParseError(`implausible string length ${len}`, this.off - 4);
    }
    const raw = this.bytes(len);
    return raw.toString(bytesPerChar === 1 ? 'ascii' : 'utf16le');
  }
}

export class BinaryWriter {
  private chunks: Buffer[] = [];

  u8(v: number): void {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v);
    this.chunks.push(b);
  }

  u16(v: number): void {
    const b = Buffer.allocUnsafe(2);
    b.writeUInt16LE(v);
    this.chunks.push(b);
  }

  i32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeInt32LE(v);
    this.chunks.push(b);
  }

  u32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeUInt32LE(v);
    this.chunks.push(b);
  }

  f32(v: number): void {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatLE(v);
    this.chunks.push(b);
  }

  f64(v: number): void {
    const b = Buffer.allocUnsafe(8);
    b.writeDoubleLE(v);
    this.chunks.push(b);
  }

  bytes(v: Buffer): void {
    this.chunks.push(v);
  }

  /** USR string; null → length -1, no payload. */
  string(v: string | null, bytesPerChar: 1 | 2): void {
    if (v === null) {
      this.i32(-1);
      return;
    }
    const raw = Buffer.from(v, bytesPerChar === 1 ? 'ascii' : 'utf16le');
    this.i32(raw.length);
    this.bytes(raw);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
