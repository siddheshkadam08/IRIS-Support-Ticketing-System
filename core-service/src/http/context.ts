import type { FastifyRequest } from 'fastify';
import { AppError } from '@iris/shared/types';
import type { ActorRole, ScopeContext } from '../db/with-scope.js';
import { findById, type ProductRow } from '../products/product.repo.js';

/**
 * core-service trusts these headers because it is never publicly bound — only
 * the gateway can reach it, and the gateway is what verified the credential.
 * INTERNAL_API_KEY stops anything else on the host from calling it directly.
 */
export interface CallerContext {
  scope: ScopeContext;
  product: ProductRow;
  raiserName: string | null;
  raiserEmail: string | null;
  productTenantId: string | null;
}

export async function resolveCaller(req: FastifyRequest): Promise<CallerContext> {
  const h = req.headers;
  const productId = str(h['x-iris-product-id']);
  const role = (str(h['x-iris-role']) ?? 'product') as ActorRole;

  if (!productId) {
    throw new AppError('unauthenticated', 'Missing resolved product context.');
  }

  const product = await findById(productId);
  if (!product || !product.is_active) {
    throw new AppError('unauthenticated', 'Unknown or inactive product.');
  }

  const raiserRef = str(h['x-iris-raiser-ref']) ?? null;
  if (role === 'raiser' && !raiserRef) {
    throw new AppError('unauthenticated', 'Raiser role requires an identity reference.');
  }

  return {
    scope: {
      productScope: [product.id],
      role,
      raiserRef,
      supportUserId: str(h['x-iris-support-user-id']) ?? null,
      requestId: req.id as string,
    },
    product,
    raiserName: decodeHeader(str(h['x-iris-raiser-name'])),
    raiserEmail: decodeHeader(str(h['x-iris-raiser-email'])),
    productTenantId: str(h['x-iris-tenant-id']) ?? null,
  };
}

function str(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Names and emails may contain non-ASCII; the gateway base64url-encodes them. */
function decodeHeader(v: string | undefined): string | null {
  if (!v) return null;
  try {
    return Buffer.from(v, 'base64url').toString('utf8');
  } catch {
    return v;
  }
}
