import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "./env";

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Callback URL passed to cloro on task submission. The token query param is
 * what authenticates incoming deliveries (same trust level as the cron
 * endpoint). Null when the deployment has no public URL (local dev) — the
 * cron sweep then picks results up by polling instead.
 */
export function webhookCallbackUrl(): string | null {
  const base = env.appUrl;
  if (!base) return null;
  return `${base}/api/webhook?token=${encodeURIComponent(env.cronSecret)}`;
}

export function verifyWebhookToken(token: string | null): boolean {
  if (!token) return false;
  const expected = Buffer.from(env.cronSecret);
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Verify cloro's optional Stripe-style HMAC signature:
 * `X-Cloro-Signature: v1=<hmac_sha256(secret, "<unix seconds>.<raw body>")>`.
 * Only enforced when CLORO_WEBHOOK_SECRET is configured.
 */
export function verifyWebhookSignature(
  rawBody: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
): boolean {
  const secret = env.cloroWebhookSecret;
  if (!secret) return true;
  if (!timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSeconds > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const provided = signatureHeader.replace(/^v1=/, "");

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}
