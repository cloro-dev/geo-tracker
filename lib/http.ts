import type { ZodType } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function jsonError(message: string, status: number): Response {
  return Response.json({ error: { message } }, { status });
}

/** Parse unknown data against a zod schema; throws a 400 HttpError on failure. */
export function parseOr400<T>(schema: ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new HttpError(400, issues);
  }
  return parsed.data;
}

/**
 * Postgres 23505 (unique violation), used to turn a duplicate insert into
 * a 409 instead of a 500 whose message is raw constraint text.
 *
 * Walks the `cause` chain: Drizzle wraps the driver error in a
 * DrizzleQueryError, so the `code` is never on the error it actually
 * throws. Checking only the top level silently never matches.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error; current != null;) {
    if (typeof current !== "object") return false;
    if ((current as { code?: string }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

type RouteContext = { params: Promise<Record<string, string>> };

/**
 * Wrap a route handler with uniform error handling: HttpError becomes its
 * status + message, anything else becomes a logged 500.
 */
export function withErrors(
  handler: (req: Request, ctx: RouteContext) => Promise<Response>,
): (req: Request, ctx: RouteContext) => Promise<Response> {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonError(error.message, error.status);
      }
      console.error("Unhandled route error:", error);
      return jsonError("Internal server error", 500);
    }
  };
}
