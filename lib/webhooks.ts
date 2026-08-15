import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "./env";

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Token embedded in the webhook callback URL, derived from the secret
 * rather than being the secret itself.
 *
 * The callback URL is handed to a third party and stored on their side, so
 * it must not carry anything that grants API access — the same secret may
 * well be the API token in a single-secret deployment. This derived value
 * only lets the holder complete a task result.
 */
function webhookToken(): string {
  return createHmac("sha256", env.cronSecret)
    .update("geo-tracker:webhook")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Callback URL passed to cloro on task submission. Null when the
 * deployment has no public URL (local dev) — the cron sweep then picks
 * results up by polling instead.
 */
export function webhookCallbackUrl(): string | null {
  const base = env.appUrl;
  if (!base) return null;
  return `${base}/api/webhook?token=${webhookToken()}`;
}

export function verifyWebhookToken(token: string | null): boolean {
  if (!token) return false;
  const expected = Buffer.from(webhookToken());
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
