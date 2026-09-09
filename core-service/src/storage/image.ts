import { AppError } from '@iris/shared/types';

/**
 * Image content validation — Phase 19 Step 1.
 *
 * ⚠️ WHAT THIS EXISTS TO STOP.
 *
 * `assertUploadAllowed` checks the content type the CLIENT declared in the
 * multipart header. Nothing has ever checked that the bytes agree with it, so
 * `Content-Type: image/png` carrying arbitrary data has always been accepted
 * and stored. That was harmless while nothing in IRIS ever decoded an
 * attachment — the file was written to disk, served back as
 * `application/octet-stream` with `nosniff`, and never interpreted.
 *
 * Screenshot AI ends that. It will read those bytes, base64 them, and post
 * them to a billed external provider. A declared type that is a lie then
 * becomes a request IRIS pays for and cannot explain, and in the worst case a
 * file chosen by the uploader to be interpreted by something other than an
 * image decoder. So the declared type has to become a CHECKED claim before
 * that pipeline exists, not after.
 *
 * ⚠️ NO NEW DEPENDENCY, DELIBERATELY.
 *
 * Every format below is identified by its container header, which is a fixed
 * byte signature plus a fixed-offset width and height. That is a few dozen
 * lines here against an image library in the dependency tree of the one
 * service that holds a database credential — and image libraries are a
 * historically rich source of memory-safety bugs, parsing exactly the
 * attacker-controlled input this file exists to distrust.
 *
 * This reads HEADERS ONLY. It never decodes pixel data, never allocates a
 * frame buffer, and never runs a decompressor. A decompression bomb is
 * rejected by reading the dimensions the header advertises, at constant cost,
 * without ever expanding anything.
 *
 * ⚠️ WHAT IT DOES NOT CLAIM. Reading a valid header is not a guarantee that
 * every later byte decodes. It proves the file is the container it claims to
 * be and that its advertised dimensions are within bounds, which is what the
 * threat here needs. A provider rejecting a truncated image later is an
 * ordinary permanent failure the existing taxonomy already handles.
 *
 * ⚠️ SCOPE NOTE. GIF is verified here but is NOT a Screenshot AI format. The
 * Phase 19 initial vision set is PNG, JPEG and WebP; GIF is on the general
 * upload allowlist and so must keep working, which means its bytes must be
 * checked like any other image. Verifying a format and analysing it are
 * different decisions and this file only makes the first one.
 */

/**
 * Image types whose content this module can verify.
 *
 * Exactly the image entries in ALLOWED_CONTENT_TYPES. Keeping the two aligned
 * matters: a declared image type this module cannot verify would silently skip
 * validation, which is the failure this whole file exists to prevent. The test
 * suite asserts the two sets agree.
 */
export const VERIFIABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export type VerifiableImageType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * Dimension bounds.
 *
 * ⚠️ THESE ARE CHOSEN AGAINST THE ATTACK, NOT AGAINST A TYPICAL SCREENSHOT,
 * because this runs on EVERY image upload and not only on ones destined for
 * vision. A bound tight enough to be "sensible for a screenshot" would reject
 * real support evidence — a full-page scrolling capture of a long report is
 * legitimately several thousand pixels tall — and a customer whose screenshot
 * is refused files a second ticket about the first one.
 *
 * The threat is a decompression bomb: a small file whose header advertises an
 * enormous canvas. Those are three orders of magnitude above anything real.
 *
 *   8K display                7680 x 4320   =  33 MP
 *   2560-wide full-page grab  2560 x 19500  =  50 MP  (at this cap)
 *   a classic PNG bomb       225000 x 225000 = 50625 MP
 *
 * So 20000 per axis and 50 MP total sits above every real screenshot and far
 * below every bomb. The gap is wide enough that neither side is a judgement
 * call.
 *
 * ⚠️ A VISION-FACING BOUND WILL BE TIGHTER, AND SEPARATE. Providers downscale
 * to roughly 2000px before tokenising, so sending 50 MP buys nothing and costs
 * real money. Step 2 should apply its own stricter limit at the dispatch
 * boundary; these constants are the SAFETY floor for storage, not a statement
 * about what is worth analysing.
 */
export const MAX_IMAGE_WIDTH = 20_000;
export const MAX_IMAGE_HEIGHT = 20_000;
export const MAX_IMAGE_PIXELS = 50_000_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

/** Normalise a header value: `image/png; charset=x` -> `image/png`. */
export function normaliseContentType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

export function isVerifiableImageType(contentType: string): boolean {
  return VERIFIABLE_IMAGE_TYPES.has(normaliseContentType(contentType));
}

// ─────────────────────────────────────────────────────────────────────────
// Detection
// ─────────────────────────────────────────────────────────────────────────

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What the BYTES say this file is, ignoring what the caller claimed.
 *
 * Returns null for anything not recognised, which the caller treats as "not
 * the declared type" rather than as "unknown but probably fine". Failing
 * closed is the entire point.
 */
export function detectImageType(buf: Buffer): VerifiableImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png';

  // JPEG: SOI marker. The third byte is the start of the next marker and is
  // always 0xFF in a real file, which cheaply rejects a two-byte prefix.
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

  // RIFF container: 'RIFF' ....  'WEBP'. The four size bytes between them are
  // not checked here; readWebpDimensions validates the chunk that follows.
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  if (buf.length >= 6) {
    const sig = buf.toString('ascii', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Dimensions
// ─────────────────────────────────────────────────────────────────────────

/**
 * PNG: the IHDR chunk is mandatory and must be FIRST, so width and height sit
 * at fixed offsets 16 and 20. The chunk type is checked rather than assumed —
 * a file with the PNG magic and something else at offset 12 is malformed, and
 * reading 8 bytes from it anyway would invent dimensions.
 */
function readPngDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG: dimensions live in a Start Of Frame segment, whose position depends on
 * how many other segments precede it, so the segment chain has to be walked.
 *
 * ⚠️ THE EXCLUSIONS MATTER. 0xC4, 0xC8 and 0xCC sit inside the 0xC0-0xCF range
 * but are DHT, JPG and DAC — not frame headers. Reading dimensions from a
 * Huffman table would produce confident nonsense.
 *
 * The walk is bounded by the buffer length and every segment length is checked
 * for forward progress, so a crafted file cannot loop this.
 */
function readJpegDimensions(buf: Buffer): ImageDimensions | null {
  let offset = 2; // past SOI
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) return null; // desynchronised: malformed
    const marker = buf[offset + 1]!;

    // Standalone markers carry no length payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null; // a length below its own field is malformed

    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 >= buf.length) return null;
      // segment: FF marker len(2) precision(1) height(2) width(2)
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * WebP: three container variants, each storing the canvas differently.
 *
 *   VP8   lossy      14-bit width/height after the 9D 01 2A sync code
 *   VP8L  lossless   14-bit width-1/height-1 packed across 4 little-endian bytes
 *   VP8X  extended   24-bit canvas width-1/height-1, little-endian
 *
 * The `- 1` in the two later variants is the spec's own encoding, not an
 * off-by-one: those formats store the dimension minus one so 16384 fits in 14
 * bits. Getting it wrong understates every image by a pixel, which no test
 * that only checks "roughly right" would ever catch.
 */
function readWebpDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 16) return null;
  const chunk = buf.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    // 12 chunk header + 8 bytes in: frame tag (3) then sync 9D 01 2A.
    if (buf.length < 30) return null;
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }

  if (chunk === 'VP8L') {
    if (buf.length < 25) return null;
    if (buf[20] !== 0x2f) return null; // VP8L signature byte
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }

  if (chunk === 'VP8X') {
    if (buf.length < 30) return null;
    const width = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1;
    const height = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1;
    return { width, height };
  }

  return null;
}

/** GIF: logical screen descriptor, little-endian, immediately after the signature. */
function readGifDimensions(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

export function readImageDimensions(buf: Buffer, type: VerifiableImageType): ImageDimensions | null {
  const dims =
    type === 'image/png'
      ? readPngDimensions(buf)
      : type === 'image/jpeg'
        ? readJpegDimensions(buf)
        : type === 'image/webp'
          ? readWebpDimensions(buf)
          : readGifDimensions(buf);

  // A zero dimension is structurally valid in some headers and is never a real
  // image. Rejecting it here keeps every caller from having to remember.
  if (!dims || dims.width <= 0 || dims.height <= 0) return null;
  return dims;
}

// ─────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────

/**
 * Assert that an upload declaring an image type really is that image, and is
 * within the dimension bounds.
 *
 * ⚠️ A NO-OP FOR EVERY NON-IMAGE TYPE, DELIBERATELY. This runs on the shared
 * upload path, and PDFs, CSVs, ZIPs and Office documents must keep behaving
 * exactly as they did. Widening this into a general "verify every attachment"
 * check would be a different, larger change with its own regression surface,
 * and it is not what Screenshot AI needs.
 *
 * The three failures map onto existing error codes rather than new ones:
 *
 *   declared type disagrees with the bytes  -> 415 attachment_type_not_allowed
 *   header unreadable / truncated / corrupt -> 400 invalid_request
 *   dimensions over bound                   -> 413 attachment_too_large
 *
 * The first two are deliberately distinct. "This is not a PNG" and "this is a
 * damaged PNG" call for different things from the person who hit them, and
 * collapsing both into one code would make a corrupted upload look like an
 * attempted bypass in the logs.
 */
export function assertImageContentValid(declaredType: string, buf: Buffer): void {
  const declared = normaliseContentType(declaredType);
  if (!VERIFIABLE_IMAGE_TYPES.has(declared)) return;

  const detected = detectImageType(buf);
  if (detected === null || detected !== declared) {
    // The DETECTED type is not echoed back. Telling a caller what their bytes
    // actually looked like turns this into an oracle for probing the check.
    throw new AppError(
      'attachment_type_not_allowed',
      `This file is not a valid ${declared.replace('image/', '').toUpperCase()} image.`,
    );
  }

  const dims = readImageDimensions(buf, detected);
  if (dims === null) {
    throw new AppError(
      'invalid_request',
      'This image file is damaged or incomplete and could not be read.',
    );
  }

  if (dims.width > MAX_IMAGE_WIDTH || dims.height > MAX_IMAGE_HEIGHT) {
    throw new AppError(
      'attachment_too_large',
      `Image is ${dims.width}x${dims.height}. The maximum is ` +
        `${MAX_IMAGE_WIDTH}x${MAX_IMAGE_HEIGHT} pixels.`,
    );
  }

  if (dims.width * dims.height > MAX_IMAGE_PIXELS) {
    throw new AppError(
      'attachment_too_large',
      `Image has ${(dims.width * dims.height).toLocaleString()} pixels. The maximum is ` +
        `${MAX_IMAGE_PIXELS.toLocaleString()}.`,
    );
  }
}
