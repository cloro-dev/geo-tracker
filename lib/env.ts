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
  get appApiKey(): string {
    return required("APP_API_KEY");
  },
  get cronSecret(): string {
    return required("CRON_SECRET");
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
