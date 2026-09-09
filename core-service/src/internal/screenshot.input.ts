import {
  AppError,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_HEIGHT,
  SCREENSHOT_MAX_PIXELS,
  SCREENSHOT_MAX_WIDTH,
  SCREENSHOT_MIME_TYPES,
  isScreenshotMimeType,
  type AIImageInput,
} from '@iris/shared/types';
import { withScope } from '../db/with-scope.js';
import { storage } from '../storage/index.js';
import {
  detectImageType,
  readImageDimensions,
  type VerifiableImageType,
} from '../storage/image.js';

/**
 * Screenshot input resolution — Phase 19 Step 2.
 *
 * ⚠️ THIS IS THE AUTHORIZATION STEP, AND IT IS THE ONLY PLACE AN ATTACHMENT ID
 * BECOMES BYTES.
 *
 * The worker never resolves an attachment. `AIJob` has no attachment field, the
 * queue payload cannot name one, and the worker's claims are checked rather
 * than trusted. The id used here comes from `event_outbox.payload` — a row Core
 * wrote itself, inside the transaction that linked the attachment to the ticket
 * (Phase 19 Step 1). There is nothing in the flow for a caller to influence
 * except the event id in the URL, which was already the case.
 *
 * ⚠️ EVERY FAILURE HERE IS PERMANENT.
 *
 * A wrong tenant, a missing attachment, an ineligible type, an oversized image
 * and bytes that are not the image they claim to be all return the same answer
 * on every retry. Classifying any of them as temporary would burn six attempts
 * and a provider bill to reach the same conclusion.
 *
 * ⚠️ THE SIZE AND DIMENSION BOUNDS ARE CHECKED HERE, BEFORE DISPATCH, so an
 * oversized screenshot costs zero provider calls. Python cannot perform this
 * check: by the time it holds the payload, the payload has already crossed.
 */

/** Types a vision model may be shown. Narrower than the upload allowlist. */
const ELIGIBLE: readonly string[] = SCREENSHOT_MIME_TYPES;

export interface ScreenshotAttachmentRow {
  id: string;
  content_type: string;
  size_bytes: string | number;
  blob_key: string;
}

export type ScreenshotInputOutcome =
  | { ok: true; attachmentId: string; image: AIImageInput }
  | { ok: false; code: string; message: string };

/** The attachment id this event named, if it named one at all. */
export function attachmentIdFromPayload(payload: Record<string, unknown>): string | null {
  const id = payload.attachment_id;
  return typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : null;
}

/**
 * Whether an event's declared content type is worth dispatching for at all.
 *
 * Read from the outbox payload, which Core wrote. Used by the dispatcher to
 * avoid creating an execution that could only ever fail, and re-checked
 * authoritatively below against the attachment ROW — because a payload is data,
 * and data is never the enforcement point.
 */
export function isEligibleScreenshotPayload(payload: Record<string, unknown>): boolean {
  const contentType = payload.content_type;
  const size = payload.size_bytes;
  if (typeof contentType !== 'string' || !isScreenshotMimeType(contentType)) return false;
  if (typeof size === 'number' && size > SCREENSHOT_MAX_BYTES) return false;
  return true;
}

/**
 * Load, authorize and bound the one image this execution will analyse.
 *
 * Opens its OWN product-scoped transaction for the attachment read — see the
 * note at the statement for why the AI scope cannot be used and why a wider one
 * would be worse.
 */
export async function resolveScreenshotImage(
  args: { ticketId: string; productId: string; payload: Record<string, unknown>; requestId: string },
): Promise<ScreenshotInputOutcome> {
  const attachmentId = attachmentIdFromPayload(args.payload);
  if (!attachmentId) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'screenshot event carries no attachment_id',
    };
  }

  /**
   * ⚠️ THE THREE-WAY PREDICATE IS THE AUTHORIZATION.
   *
   * `id` alone is not enough, and neither is `id` plus RLS. The attachment must
   * belong to THIS ticket and THIS product — the ticket and product Core
   * resolved from its own outbox row — so an attachment linked to a different
   * ticket in the same tenant is as invisible here as one in another tenant.
   * RLS constrains the product; the explicit predicates constrain the ticket
   * and make both visible in the statement.
   *
   * `blob_key` is read and never leaves this function: it is an internal
   * storage path and appears in no response, no result and no log line.
   *
   * ⚠️ READ UNDER `role: 'product'`, NOT UNDER THE AI SCOPE — and this is a
   * finding, not a preference.
   *
   * Every other AI feature reads the TICKET, and `ticket_isolation` admits the
   * AI actor's `role: 'none'` because it only requires a product match and a
   * non-raiser. `attachment_isolation` (migration 008) is stricter: it
   * enumerates the roles that may see a LINKED attachment — staff, an agent
   * holding a grant, the owning raiser, and the integrating product — and
   * `none` is in none of them. So the AI scope genuinely cannot read this row,
   * and RLS refusing it is the zero-standing-access model working rather than a
   * bug to route around.
   *
   * The answer is a NARROWER scope, not a wider one. `role: 'product'` matches
   * the existing policy arm `(app_role() = 'product' AND ticket_id IS NOT NULL)`
   * — "the owning product may read its own linked attachments" — and
   * `productScope` still forces `product_id = ANY (app_scope())`. So isolation
   * is still enforced by the database, and the policy was not touched.
   *
   * ⚠️ NOT `withSystemScope`. Super-admin scope would also have worked and
   * would have made the explicit predicates below the only real constraint.
   * That is a strictly weaker position for a read whose entire purpose is to
   * decide which customer's image is about to be sent to a third party.
   *
   * Its own transaction, because it is a read that must not widen the scope of
   * the caller's — the caller holds the AI scope for the execution ledger.
   */
  const row = await withScope(
    { productScope: [args.productId], role: 'product', requestId: args.requestId },
    async (tx) => {
      const { rows } = await tx.query<ScreenshotAttachmentRow>(
        `SELECT id, content_type, size_bytes, blob_key
           FROM attachment
          WHERE id = $1 AND ticket_id = $2 AND product_id = $3`,
        [attachmentId, args.ticketId, args.productId],
      );
      return rows[0] ?? null;
    },
  );
  if (!row) {
    // Indistinguishable from "does not exist", exactly as everywhere else.
    return {
      ok: false,
      code: 'attachment_not_found',
      message: 'no such attachment is visible for this AI job',
    };
  }

  if (!ELIGIBLE.includes(row.content_type)) {
    /**
     * NOT AN ERROR IN THE ORDINARY SENSE. Attaching a CSV or a PDF to a ticket
     * is normal, and the link event fires for every attachment. This is the
     * expected terminal outcome for one, and it is permanent: the type will not
     * change. The dispatcher normally avoids creating this execution at all;
     * reaching here means the payload and the row disagreed, which is worth
     * recording rather than hiding.
     */
    return {
      ok: false,
      code: 'unsupported_media_type',
      message: `${row.content_type} is not analysed; screenshot accepts ${ELIGIBLE.join(', ')}`,
    };
  }

  const declaredSize = Number(row.size_bytes);
  if (Number.isFinite(declaredSize) && declaredSize > SCREENSHOT_MAX_BYTES) {
    return {
      ok: false,
      code: 'image_too_large',
      message: `attachment is ${declaredSize} bytes; the vision limit is ${SCREENSHOT_MAX_BYTES}`,
    };
  }

  let bytes: Buffer;
  try {
    bytes = await storage.get(row.blob_key);
  } catch (err) {
    /**
     * The row exists but its blob does not. Permanent: a missing object does
     * not reappear, and retrying six times would not find it. The blob key is
     * deliberately excluded from the message.
     */
    return {
      ok: false,
      code: 'attachment_unavailable',
      message: `attachment content could not be read: ${err instanceof Error ? err.name : 'unknown error'}`,
    };
  }

  // Re-check the true size. `size_bytes` is what was recorded at upload; this
  // is what will actually be sent.
  if (bytes.byteLength > SCREENSHOT_MAX_BYTES) {
    return {
      ok: false,
      code: 'image_too_large',
      message: `image is ${bytes.byteLength} bytes; the vision limit is ${SCREENSHOT_MAX_BYTES}`,
    };
  }

  /**
   * ⚠️ THE BYTES ARE RE-VERIFIED HERE EVEN THOUGH UPLOAD ALREADY DID IT.
   *
   * Step 1 checks magic bytes at upload, so a stored `image/png` should be a
   * PNG. "Should be" is the reason this runs again: the storage adapter is
   * swappable, the row and the object are two different things, and this is the
   * last point before customer-supplied bytes are sent to an external provider.
   * The check is a few microseconds against a request that costs money.
   */
  const detected = detectImageType(bytes);
  if (detected === null || detected !== row.content_type) {
    return {
      ok: false,
      code: 'invalid_input',
      message: 'stored bytes do not match the recorded image type',
    };
  }

  const dims = readImageDimensions(bytes, detected as VerifiableImageType);
  if (dims === null) {
    return { ok: false, code: 'invalid_input', message: 'image header could not be read' };
  }

  /**
   * ⚠️ TIGHTER THAN THE STORAGE BOUNDS, DELIBERATELY.
   *
   * Step 1's 20000/50 MP limits exist to stop decompression bombs on every
   * upload. These exist because a vision model tiles an image and stops gaining
   * signal past roughly 2000px on the short side, so an enormous canvas is
   * billed as a large image and read as a small one. Two different questions,
   * two different numbers, and using the storage limit here would silently mean
   * "no vision limit at all".
   */
  if (dims.width > SCREENSHOT_MAX_WIDTH || dims.height > SCREENSHOT_MAX_HEIGHT) {
    return {
      ok: false,
      code: 'image_too_large',
      message: `image is ${dims.width}x${dims.height}; the vision limit is ${SCREENSHOT_MAX_WIDTH}x${SCREENSHOT_MAX_HEIGHT}`,
    };
  }
  if (dims.width * dims.height > SCREENSHOT_MAX_PIXELS) {
    return {
      ok: false,
      code: 'image_too_large',
      message: `image has ${dims.width * dims.height} pixels; the vision limit is ${SCREENSHOT_MAX_PIXELS}`,
    };
  }

  return {
    ok: true,
    attachmentId: row.id,
    /**
     * ⚠️ TYPE AND BYTES, AND NOTHING ELSE.
     *
     * No attachment id, no filename, no blob key, no ticket id, no product id.
     * Python cannot attribute this image to a tenant, so it cannot mix two of
     * them up — the same property that makes the embedding path safe. The
     * attachment id stays on THIS side and is attached to the result by Core.
     */
    image: { content_type: row.content_type, base64: bytes.toString('base64') },
  };
}

/**
 * Turn a resolution failure into the error Core records.
 *
 * Always permanent, so it is surfaced as an execution failure rather than
 * thrown as a 4xx: a 4xx would send the worker into a retry loop over a
 * condition that cannot change.
 */
export function screenshotInputError(outcome: { code: string; message: string }): AppError {
  return new AppError('invalid_request', outcome.message, { code: outcome.code });
}
