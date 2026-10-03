/**
 * Best-effort write throttle for anonymous callers.
 *
 * khata has no accounts, so the only thing standing between it and a bored
 * script is this. It is a per-process, in-memory token bucket, which on
 * serverless means: it protects one warm instance and nothing else. That is
 * stated in the README rather than glossed over, because pretending a
 * serverless in-memory limiter is a real one would be the exact kind of
 * overclaim this project is built to avoid.
 *
 * For a real deployment, put a hosted limiter in front (Vercel WAF, Cloudflare
 * rate limiting) and keep this as the application-level backstop.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const CAPACITY = 20;
const REFILL_PER_SECOND = 0.2; // 12 writes per minute, sustained.

const buckets = new Map<string, Bucket>();

export interface RateDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  scope: string;
}

export function consumeWrite(key: string, scope = "write"): RateDecision {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket) {
    buckets.set(key, { tokens: CAPACITY - 1, updatedAt: now });
    return { allowed: true, remaining: CAPACITY - 1, retryAfterSeconds: 0, scope };
  }

  const elapsedSeconds = Math.max(0, (now - bucket.updatedAt) / 1000);
  const tokens = Math.min(CAPACITY, bucket.tokens + elapsedSeconds * REFILL_PER_SECOND);
  bucket.updatedAt = now;

  if (tokens < 1) {
    bucket.tokens = tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((1 - tokens) / REFILL_PER_SECOND),
      scope,
    };
  }

  bucket.tokens = tokens - 1;
  return { allowed: true, remaining: Math.floor(tokens - 1), retryAfterSeconds: 0, scope };
}

/**
 * Best-effort client IP, from the first proxy hop that set a header.
 *
 * Deliberately not treated as an identity: `x-forwarded-for` is client-settable
 * when there is no proxy in front. It is one signal among several, used to slow
 * a single caller down, never to grant or deny ownership.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip")?.trim() || "unknown";
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear();
}