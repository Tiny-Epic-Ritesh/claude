/**
 * Outbound HTTP for vendor calls.
 *
 * Three things every integration gets wrong at 3am, handled once here:
 *
 *   1. No timeout. A vendor that accepts the connection and never answers will
 *      otherwise hold a request until the client gives up. Every call is bounded.
 *   2. Retrying non-idempotent writes. Retrying a failed "send WhatsApp" can
 *      double-send. We retry only on transport failure and 5xx/429 — never on a
 *      4xx, which means the vendor understood us and said no.
 *   3. Logging the request body. Vendor payloads carry mobile numbers and PANs,
 *      so the log records status and timing, never content.
 */

import { TIMEOUT_MS } from './config.js';
import { audit } from '../db.js';

export class VendorError extends Error {
  constructor(vendor, message, { status = null, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'VendorError';
    this.vendor = vendor;
    this.status = status;
    this.retryable = retryable;
    // Kept for the operator-facing error surface, never written to the audit log.
    this.vendorBody = body;
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * One vendor request.
 *
 * `attempts` counts total tries, not retries. Backoff is exponential with jitter,
 * because a vendor outage means every one of our workers retries at once, and
 * synchronised retries are how a recovering service gets knocked over again.
 */
export async function vendorFetch(vendor, url, {
  method = 'POST',
  headers = {},
  body = null,
  attempts = 3,
  timeoutMs = TIMEOUT_MS,
  expectJson = true,
} = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
        },
        body: body === null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
        signal: controller.signal,
      });

      const elapsed = Date.now() - startedAt;
      const text = await res.text();

      if (!res.ok) {
        const retryable = RETRYABLE_STATUS.has(res.status);
        lastError = new VendorError(vendor, `${vendor} returned HTTP ${res.status}`, {
          status: res.status, retryable, body: text.slice(0, 500),
        });

        // Status and timing only — the response body can echo the request.
        audit(null, 'vendor_call_failed', 'integration', null, {
          vendor, status: res.status, attempt, elapsed_ms: elapsed, retryable,
        });

        if (!retryable || attempt === attempts) throw lastError;
      } else {
        audit(null, 'vendor_call', 'integration', null, {
          vendor, status: res.status, attempt, elapsed_ms: elapsed,
        });

        if (!expectJson) return { ok: true, status: res.status, text };
        try {
          return { ok: true, status: res.status, data: text ? JSON.parse(text) : null, text };
        } catch {
          // A vendor that advertises JSON and sends HTML is usually an error page
          // or a captive portal. Surface it rather than pretending it parsed.
          throw new VendorError(vendor, `${vendor} returned a non-JSON body`, {
            status: res.status, retryable: false, body: text.slice(0, 500),
          });
        }
      }
    } catch (err) {
      if (err instanceof VendorError && !err.retryable) throw err;

      lastError = err instanceof VendorError ? err : new VendorError(
        vendor,
        err.name === 'AbortError' ? `${vendor} timed out after ${timeoutMs}ms` : `${vendor} unreachable: ${err.message}`,
        { retryable: true },
      );

      if (attempt === attempts) throw lastError;
    } finally {
      clearTimeout(timer);
    }

    await sleep(Math.round((2 ** (attempt - 1)) * 250 * (1 + Math.random())));
  }

  throw lastError;
}

/**
 * Constant-time comparison for webhook signatures.
 * A plain `===` on a secret leaks its prefix through timing.
 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  // eslint-disable-next-line no-bitwise
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}
