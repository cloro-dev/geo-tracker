/**
 * Typed access to environment variables. Required vars throw at first use
 * (not at import), so `next build` succeeds without any of them set.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  get cloroApiKey(): string {
    return required("CLORO_API_KEY");
  },
  get cloroApiUrl(): string {
    return process.env.CLORO_API_URL ?? "https://api.cloro.dev";
  },
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  /**
   * The bearer token clients send to the REST API and the MCP endpoint.
   *
   * One secret is enough for a whole deployment: Vercel Cron can only
   * authenticate itself through a variable literally named `CRON_SECRET`,
   * so that is the one we ask for, and it doubles as the API token. Set
   * `APP_API_KEY` as well if you would rather the two be separate.
   */
  get apiToken(): string {
    return process.env.APP_API_KEY ?? required("CRON_SECRET");
  },
  /** Secret Vercel Cron sends, and the seed for the webhook token. */
  get cronSecret(): string {
    return process.env.CRON_SECRET ?? required("APP_API_KEY");
  },
  /**
   * Public base URL of this deployment, used to build the webhook callback
   * URL. Falls back to Vercel's production URL; null when neither is set
   * (e.g. local dev), in which case tasks are submitted without a webhook
   * and the cron sweep picks results up by polling.
   */
  get appUrl(): string | null {
    const explicit = process.env.APP_URL;
    if (explicit) return explicit.replace(/\/+$/, "");
    const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
    if (vercel) return `https://${vercel}`;
    return null;
  },
  get cloroWebhookSecret(): string | null {
    return process.env.CLORO_WEBHOOK_SECRET ?? null;
  },
};
