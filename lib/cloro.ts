import { env } from "./env";
import { buildPayload, toTaskType, type Engine } from "./engines";

// Defensive view of the cloro error envelope — bodies from a proxy or load
// balancer in front of the API may not conform to it.
interface CloroErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

interface CloroTaskBody {
  task?: {
    id?: string;
    status?: string;
  };
  credits?: {
    creditsCharged?: number | null;
  };
  response?: unknown;
}

export interface FetchedTask {
  status: "pending" | "completed" | "failed";
  response: unknown;
  creditsCharged: number;
}

const REQUEST_TIMEOUT_MS = 30_000;

async function cloroRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, env.cloroApiUrl), {
      method,
      headers: {
        authorization: `Bearer ${env.cloroApiKey}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `cloro API request to ${path} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const json: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const apiError = (json as CloroErrorBody | undefined)?.error;
    throw new Error(
      `cloro API error ${response.status}${
        apiError?.code ? ` (${apiError.code})` : ""
      }: ${apiError?.message ?? "request failed"}${
        apiError?.details ? ` — ${JSON.stringify(apiError.details)}` : ""
      }`,
    );
  }

  return json;
}

/**
 * Submit an async scrape task. Returns the cloro task id. The result is
 * delivered to `webhookUrl` when the scrape finishes (or picked up by the
 * cron sweep if no webhook URL is available).
 */
export async function submitTask(
  engine: Engine,
  prompt: string,
  country: string,
  options: { webhookUrl?: string; idempotencyKey?: string } = {},
): Promise<string> {
  const json = (await cloroRequest("POST", "/v1/async/task", {
    taskType: toTaskType(engine),
    payload: buildPayload(engine, prompt, country),
    ...(options.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
    ...(options.webhookUrl ? { webhook: { url: options.webhookUrl } } : {}),
  })) as CloroTaskBody;

  const taskId = json.task?.id;
  if (!taskId) {
    throw new Error("cloro API returned no task id for async submission");
  }
  return taskId;
}

export function mapTaskStatus(
  status: string | undefined,
): FetchedTask["status"] {
  if (status === "COMPLETED") return "completed";
  if (status === "FAILED") return "failed";
  return "pending";
}

/** Poll one async task — the fallback path when a webhook never arrives. */
export async function fetchTask(taskId: string): Promise<FetchedTask> {
  const json = (await cloroRequest(
    "GET",
    `/v1/async/task/${encodeURIComponent(taskId)}`,
  )) as CloroTaskBody;

  return {
    status: mapTaskStatus(json.task?.status),
    response: json.response ?? null,
    creditsCharged: json.credits?.creditsCharged ?? 0,
  };
}
