import { describe, expect, it } from 'vitest';
import { AppError } from '@iris/shared/types';
import { ALLOWED_CONTENT_TYPES } from './index.js';
import {
  MAX_IMAGE_HEIGHT,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_WIDTH,
  VERIFIABLE_IMAGE_TYPES,
  assertImageContentValid,
  detectImageType,
  isVerifiableImageType,
  readImageDimensions,
} from './image.js';

/**
 * Image content validation — Phase 19 Step 1.
 *
 * ⚠️ EVERY FIXTURE HERE IS BUILT BYTE BY BYTE, not read from disk.
 *
 * That is the point of the file. A test that loads a real PNG proves the
 * parser works on well-formed input, which was never in doubt; the failures
 * this guard exists for are all MALFORMED — a JPEG magic number in front of
 * nothing, a PNG whose IHDR is truncated, a header advertising a canvas that
 * would never be decoded. Those cases can only be constructed.
 *
 * The dimension fixtures matter most. A bomb is a small file claiming an
 * enormous canvas, so the header is the whole attack surface, and building one
 * is four bytes.
 */

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

/** A structurally valid PNG header with an arbitrary declared canvas. */
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** JPEG: SOI, one non-SOF segment to force the walk, then an SOF0. */
function jpeg(width: number, height: number, { skipSegment = true } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (skipSegment) {
    // APP0/JFIF — a segment the walker must step over rather than read.
    const app0 = Buffer.alloc(4 + 14);
    app0.writeUInt8(0xff, 0);
    app0.writeUInt8(0xe0, 1);
    app0.writeUInt16BE(16, 2);
    app0.write('JFIF\0', 4, 'ascii');
    parts.push(app0);
  }
  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1); // SOF0
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

/** WebP lossy (VP8 ). */
function webpLossy(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  buf.writeUInt8(0x9d, 23);
  buf.writeUInt8(0x01, 24);
  buf.writeUInt8(0x2a, 25);
  buf.writeUInt16LE(width, 26);
  buf.writeUInt16LE(height, 28);
  return buf;
}

/** WebP lossless (VP8L) — 14-bit width-1/height-1 packed little-endian. */
function webpLossless(width: number, height: number): Buffer {
  const buf = Buffer.alloc(25);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(17, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(5, 16);
  buf.writeUInt8(0x2f, 20);
  buf.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return buf;
}

/** WebP extended (VP8X) — 24-bit canvas minus one. */
function webpExtended(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8X', 12, 'ascii');
  buf.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buf.writeUInt8(w & 0xff, 24);
  buf.writeUInt8((w >> 8) & 0xff, 25);
  buf.writeUInt8((w >> 16) & 0xff, 26);
  buf.writeUInt8(h & 0xff, 27);
  buf.writeUInt8((h >> 8) & 0xff, 28);
  buf.writeUInt8((h >> 16) & 0xff, 29);
  return buf;
}

function gif(width: number, height: number): Buffer {
  const buf = Buffer.alloc(10);
  buf.write('GIF89a', 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

const code = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'not_an_AppError';
  }
  return 'no_error';
};

// ═══════════════════════════════════════════════════════════════════════
// The verifiable set matches the upload allowlist
// ═══════════════════════════════════════════════════════════════════════

describe('every image type the upload allowlist permits can be verified', () => {
  /**
   * ⚠️ THE INVARIANT THAT MAKES THE GUARD MEANINGFUL. A declared image type
   * this module cannot recognise would fall through `assertImageContentValid`
   * silently and be stored unchecked — the exact hole the guard exists to
   * close, reopened by adding one line to a different file.
   */
  it('the allowlist contains no image type outside VERIFIABLE_IMAGE_TYPES', () => {
    const allowedImages = [...ALLOWED_CONTENT_TYPES].filter((t) => t.startsWith('image/'));
    expect(allowedImages.sort()).toEqual([...VERIFIABLE_IMAGE_TYPES].sort());
  });

  it('non-image types are not treated as verifiable', () => {
    for (const t of ['application/pdf', 'text/csv', 'application/zip', 'text/plain']) {
      expect(isVerifiableImageType(t)).toBe(false);
    }
  });

  it('a parameterised header still resolves', () => {
    expect(isVerifiableImageType('image/png; charset=binary')).toBe(true);
    expect(isVerifiableImageType('IMAGE/PNG')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Detection
// ═══════════════════════════════════════════════════════════════════════

describe('detection reads the bytes, not the claim', () => {
  it('identifies PNG', () => expect(detectImageType(png(10, 10))).toBe('image/png'));
  it('identifies JPEG', () => expect(detectImageType(jpeg(10, 10))).toBe('image/jpeg'));
  it('identifies WebP lossy', () => expect(detectImageType(webpLossy(10, 10))).toBe('image/webp'));
  it('identifies WebP lossless', () => expect(detectImageType(webpLossless(10, 10))).toBe('image/webp'));
  it('identifies WebP extended', () => expect(detectImageType(webpExtended(10, 10))).toBe('image/webp'));
  it('identifies GIF', () => expect(detectImageType(gif(10, 10))).toBe('image/gif'));

  it.each([
    ['empty', Buffer.alloc(0)],
    ['plain text', Buffer.from('this is not an image at all')],
    ['a ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['a PDF', Buffer.from('%PDF-1.7\n%????\n')],
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['a truncated PNG magic', Buffer.from([0x89, 0x50, 0x4e])],
    ['RIFF that is not WebP', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])],
  ])('returns null for %s', (_label, buf) => {
    expect(detectImageType(buf)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Dimensions
// ═══════════════════════════════════════════════════════════════════════

describe('dimensions are read from the container header', () => {
  it('PNG', () => expect(readImageDimensions(png(1920, 1080), 'image/png')).toEqual({ width: 1920, height: 1080 }));

  it('JPEG, stepping over a preceding segment', () => {
    expect(readImageDimensions(jpeg(2560, 1440), 'image/jpeg')).toEqual({ width: 2560, height: 1440 });
  });

  it('JPEG with the SOF first', () => {
    expect(readImageDimensions(jpeg(640, 480, { skipSegment: false }), 'image/jpeg')).toEqual({
      width: 640,
      height: 480,
    });
  });

  /**
   * ⚠️ 0xC4 IS DHT, NOT A FRAME HEADER. It sits inside the 0xC0-0xCF range, so
   * a naive walker reads a Huffman table as dimensions and returns confident
   * nonsense. Here the DHT advertises 8x8; the real SOF that follows says
   * 800x600, and only the second is correct.
   */
  it('JPEG does not mistake a Huffman table for a frame header', () => {
    const dht = Buffer.alloc(11);
    dht.writeUInt8(0xff, 0);
    dht.writeUInt8(0xc4, 1); // DHT
    dht.writeUInt16BE(9, 2);
    dht.writeUInt8(8, 4);
    dht.writeUInt16BE(8, 5);
    dht.writeUInt16BE(8, 7);
    const file = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, jpeg(800, 600, { skipSegment: false }).subarray(2)]);
    expect(readImageDimensions(file, 'image/jpeg')).toEqual({ width: 800, height: 600 });
  });

  it('WebP lossy', () => expect(readImageDimensions(webpLossy(1280, 720), 'image/webp')).toEqual({ width: 1280, height: 720 }));

  /**
   * VP8L and VP8X store the dimension MINUS ONE. Getting that wrong understates
   * every image by a pixel, which a "roughly right" assertion would never catch.
   */
  it('WebP lossless decodes the minus-one encoding exactly', () => {
    expect(readImageDimensions(webpLossless(1280, 720), 'image/webp')).toEqual({ width: 1280, height: 720 });
    expect(readImageDimensions(webpLossless(1, 1), 'image/webp')).toEqual({ width: 1, height: 1 });
  });

  it('WebP extended decodes the 24-bit minus-one encoding exactly', () => {
    expect(readImageDimensions(webpExtended(3840, 2160), 'image/webp')).toEqual({ width: 3840, height: 2160 });
  });

  it('GIF', () => expect(readImageDimensions(gif(500, 400), 'image/gif')).toEqual({ width: 500, height: 400 }));

  it('returns null for a truncated PNG header', () => {
    expect(readImageDimensions(png(10, 10).subarray(0, 20), 'image/png')).toBeNull();
  });

  it('returns null when PNG magic is followed by the wrong chunk', () => {
    const bad = png(10, 10);
    bad.write('IDAT', 12, 'ascii');
    expect(readImageDimensions(bad, 'image/png')).toBeNull();
  });

  it('returns null for a JPEG with no frame header at all', () => {
    expect(readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]), 'image/jpeg')).toBeNull();
  });

  it('returns null for a zero dimension', () => {
    expect(readImageDimensions(png(0, 100), 'image/png')).toBeNull();
    expect(readImageDimensions(png(100, 0), 'image/png')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The guard
// ═══════════════════════════════════════════════════════════════════════

describe('a valid image of its declared type is accepted', () => {
  it.each([
    ['image/png', png(1920, 1080)],
    ['image/jpeg', jpeg(1920, 1080)],
    ['image/webp', webpLossy(1920, 1080)],
    ['image/webp', webpLossless(1920, 1080)],
    ['image/gif', gif(600, 400)],
  ])('%s', (type, buf) => {
    expect(() => assertImageContentValid(type, buf)).not.toThrow();
  });

  it('a 1x1 image is fine', () => {
    expect(() => assertImageContentValid('image/png', png(1, 1))).not.toThrow();
  });
});

describe('SEC-7 a spoofed MIME type is rejected', () => {
  /**
   * The case this whole file exists for: the multipart header says PNG and the
   * bytes are something else entirely. Every one of these was accepted and
   * stored before Phase 19 Step 1.
   */
  it.each([
    ['arbitrary bytes', Buffer.from('MZ\x90\x00 not an image')],
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['HTML', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['a ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0])],
    ['a PDF', Buffer.from('%PDF-1.7\n')],
    ['empty', Buffer.alloc(0)],
  ])('image/png carrying %s', (_label, buf) => {
    expect(code(() => assertImageContentValid('image/png', buf))).toBe('attachment_type_not_allowed');
  });

  it('one real image type declared as another is rejected', () => {
    expect(code(() => assertImageContentValid('image/png', jpeg(10, 10)))).toBe('attachment_type_not_allowed');
    expect(code(() => assertImageContentValid('image/jpeg', png(10, 10)))).toBe('attachment_type_not_allowed');
    expect(code(() => assertImageContentValid('image/webp', gif(10, 10)))).toBe('attachment_type_not_allowed');
  });

  /** The refusal must not report what the bytes actually were. */
  it('the message is not an oracle for the detected type', () => {
    try {
      assertImageContentValid('image/png', jpeg(10, 10));
      throw new Error('should have thrown');
    } catch (e) {
      const message = (e as AppError).message;
      expect(message).not.toMatch(/jpeg/i);
      expect(message).toMatch(/PNG/);
    }
  });
});

describe('SEC-8 a corrupted image is rejected', () => {
  it('a PNG whose header is truncated', () => {
    expect(code(() => assertImageContentValid('image/png', png(10, 10).subarray(0, 20)))).toBe('invalid_request');
  });

  it('a PNG whose first chunk is not IHDR', () => {
    const bad = png(10, 10);
    bad.write('IDAT', 12, 'ascii');
    expect(code(() => assertImageContentValid('image/png', bad))).toBe('invalid_request');
  });

  it('a JPEG with no frame header', () => {
    const bad = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    expect(code(() => assertImageContentValid('image/jpeg', bad))).toBe('invalid_request');
  });

  it('a WebP whose chunk type is unknown', () => {
    const bad = webpLossy(10, 10);
    bad.write('XXXX', 12, 'ascii');
    expect(code(() => assertImageContentValid('image/webp', bad))).toBe('invalid_request');
  });

  it('a WebP lossy missing its sync code', () => {
    const bad = webpLossy(10, 10);
    bad.writeUInt8(0x00, 23);
    expect(code(() => assertImageContentValid('image/webp', bad))).toBe('invalid_request');
  });

  /**
   * ⚠️ CORRUPT AND SPOOFED ARE DIFFERENT ANSWERS. A damaged upload from an
   * honest customer and a deliberate type mismatch call for different responses
   * from whoever reads the logs, so they carry different codes.
   */
  it('corrupt is invalid_request while spoofed is attachment_type_not_allowed', () => {
    expect(code(() => assertImageContentValid('image/png', png(10, 10).subarray(0, 20)))).toBe('invalid_request');
    expect(code(() => assertImageContentValid('image/png', Buffer.from('nope')))).toBe('attachment_type_not_allowed');
  });
});

describe('SEC-10 an over-dimensioned image is rejected', () => {
  it('width over the bound', () => {
    expect(code(() => assertImageContentValid('image/png', png(MAX_IMAGE_WIDTH + 1, 10)))).toBe('attachment_too_large');
  });

  it('height over the bound', () => {
    expect(code(() => assertImageContentValid('image/png', png(10, MAX_IMAGE_HEIGHT + 1)))).toBe('attachment_too_large');
  });

  it('exactly at the bound is accepted', () => {
    expect(() => assertImageContentValid('image/png', png(MAX_IMAGE_WIDTH, 1))).not.toThrow();
    expect(() => assertImageContentValid('image/png', png(1, MAX_IMAGE_HEIGHT))).not.toThrow();
  });

  /**
   * THE DECOMPRESSION BOMB. Both axes are individually under the per-axis
   * bound, so only the pixel product catches it. This is a 24-byte file.
   */
  it('a pixel count over the bound is rejected even when both axes pass', () => {
    const w = 19_000;
    const h = 19_000;
    expect(w).toBeLessThanOrEqual(MAX_IMAGE_WIDTH);
    expect(h).toBeLessThanOrEqual(MAX_IMAGE_HEIGHT);
    expect(w * h).toBeGreaterThan(MAX_IMAGE_PIXELS);
    expect(code(() => assertImageContentValid('image/png', png(w, h)))).toBe('attachment_too_large');
  });

  it('the classic PNG bomb is rejected', () => {
    expect(code(() => assertImageContentValid('image/png', png(225_000, 225_000)))).toBe('attachment_too_large');
  });

  it('bombs in every verified format are rejected', () => {
    expect(code(() => assertImageContentValid('image/jpeg', jpeg(65_000, 65_000)))).toBe('attachment_too_large');
    expect(code(() => assertImageContentValid('image/gif', gif(65_000, 65_000)))).toBe('attachment_too_large');
    expect(code(() => assertImageContentValid('image/webp', webpExtended(80_000, 80_000)))).toBe('attachment_too_large');
  });

  /** Real screenshots, including a tall full-page capture, must still pass. */
  it.each([
    ['1080p', 1920, 1080],
    ['4K', 3840, 2160],
    ['8K', 7680, 4320],
    ['a tall full-page capture', 2560, 19_000],
  ])('accepts %s', (_label, w, h) => {
    expect(() => assertImageContentValid('image/png', png(w, h))).not.toThrow();
  });
});

describe('non-image uploads are untouched by this guard', () => {
  /**
   * The upload path is shared. If this were not a no-op for other types, every
   * PDF, CSV, ZIP and Office document would start failing — a regression in a
   * feature that has nothing to do with Screenshot AI.
   */
  it.each([
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ])('%s content is not inspected', (type) => {
    expect(() => assertImageContentValid(type, Buffer.from('anything at all'))).not.toThrow();
    expect(() => assertImageContentValid(type, Buffer.alloc(0))).not.toThrow();
  });
});
