import { mapTaskStatus } from "@/lib/cloro";
import { jsonError, withErrors } from "@/lib/http";
import { completeResult } from "@/lib/runner";
import { verifyWebhookSignature, verifyWebhookToken } from "@/lib/webhooks";

export const runtime = "nodejs";

interface WebhookBody {
  task?: {
    id?: string;
    status?: string;
  };
  credits?: {
    creditsCharged?: number | null;
  };
  response?: unknown;
}

/**
 * Receives cloro async-task webhooks. Authenticated by the token query
 * param baked into the callback URL at submission time, plus the optional
 * HMAC signature when CLORO_WEBHOOK_SECRET is configured. Always answers
 * 200 for well-formed deliveries we can't match — cloro retries on non-2xx
 * and an unknown task id will never become known.
 */
export const POST = withErrors(async (req) => {
  const token = new URL(req.url).searchParams.get("token");
  if (!verifyWebhookToken(token)) return jsonError("Unauthorized", 401);

  const rawBody = await req.text();
  const signatureOk = verifyWebhookSignature(
    rawBody,
    req.headers.get("x-cloro-timestamp"),
    req.headers.get("x-cloro-signature"),
  );
  if (!signatureOk) return jsonError("Invalid signature", 401);

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const taskId = body.task?.id;
  if (!taskId) return jsonError("Missing task id", 400);

  const status = mapTaskStatus(body.task?.status);
  if (status === "pending") {
    // Not a terminal state — nothing to record.
    return Response.json({ ok: true, applied: false });
  }

  const applied = await completeResult(taskId, {
    status,
    response: body.response,
    creditsCharged: body.credits?.creditsCharged ?? 0,
    error: status === "failed" ? "Task failed" : null,
  });

  return Response.json({ ok: true, applied });
});
