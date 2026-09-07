import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, resolveFromRoot } from '@iris/shared/types';
import { config } from '../config.js';

/**
 * Attachment content-type allowlist.
 *
 * SVG and HTML are blocked deliberately: an SVG rendered inline in the admin
 * portal executes script in an authenticated super-admin session — a full
 * platform compromise delivered through a mandated feature. Attachments are
 * additionally served with Content-Disposition: attachment and never inline.
 */
export const ALLOWED_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const BLOCKED_CONTENT_TYPES = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/javascript',
  'text/javascript',
]);

export interface StorageAdapter {
  put(productId: string, filename: string, contentType: string, data: Buffer): Promise<string>;
  get(blobKey: string): Promise<Buffer>;
}

/**
 * Local-disk adapter. The interface exists so MinIO/Azure Blob swap in without
 * touching a single caller — same code path, one config value.
 */
class LocalDiskStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

  async put(
    productId: string,
    filename: string,
    _contentType: string,
    data: Buffer,
  ): Promise<string> {
    const digest = createHash('sha256').update(data).digest('hex').slice(0, 16);
    const safeName = path.basename(filename).replace(/[^\w.\-]/g, '_');
    const key = `${productId}/${randomUUID()}-${digest}-${safeName}`;
    const full = path.resolve(this.root, key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    return key;
  }

  async get(blobKey: string): Promise<Buffer> {
    const full = path.resolve(this.root, blobKey);
    // Guard against traversal via a crafted blob key.
    if (!full.startsWith(path.resolve(this.root))) {
      throw new AppError('invalid_request', 'Invalid blob key.');
    }
    return readFile(full);
  }
}

// Repo-root anchored, so attachments land in the same place whether the
// service is started from the root or via its workspace script.
export const storage: StorageAdapter = new LocalDiskStorage(
  resolveFromRoot(config.STORAGE_LOCAL_PATH),
);

export function assertUploadAllowed(contentType: string, sizeBytes: number): void {
  if (sizeBytes > config.MAX_ATTACHMENT_BYTES) {
    throw new AppError('attachment_too_large', 'Attachment exceeds the 25 MB limit.');
  }
  const ct = contentType.split(';')[0]!.trim().toLowerCase();
  if (BLOCKED_CONTENT_TYPES.has(ct) || !ALLOWED_CONTENT_TYPES.has(ct)) {
    throw new AppError('attachment_type_not_allowed', `Content type '${ct}' is not permitted.`, {
      allowed: [...ALLOWED_CONTENT_TYPES],
    });
  }
}
