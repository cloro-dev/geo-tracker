import { z } from "zod";

import { ENGINES } from "./engines";

export const createPromptSchema = z.object({
  name: z.string().min(1).max(200),
  prompt: z.string().min(1).max(10_000),
  engines: z.array(z.enum(ENGINES)).min(1),
  country: z
    .string()
    .length(2)
    .transform((value) => value.toUpperCase())
    .default("US"),
  runsPerDay: z.number().int().min(1).max(24).default(1),
  enabled: z.boolean().default(true),
});

export const updatePromptSchema = z
  .object({
    name: z.string().min(1).max(200),
    prompt: z.string().min(1).max(10_000),
    engines: z.array(z.enum(ENGINES)).min(1),
    country: z
      .string()
      .length(2)
      .transform((value) => value.toUpperCase()),
    runsPerDay: z.number().int().min(1).max(24),
    enabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  });

/**
 * A domain, not a URL: "acme.io", never "https://acme.io/path".
 *
 * Accepting a URL here and quietly parsing it out would be friendlier for
 * about a week, until someone entered "acme.io/blog" and wondered why the
 * citations never matched. The extractor compares against a hostname, so
 * that is what this asks for.
 */
const domainSchema = z
  .string()
  .min(1)
  .max(253)
  .transform((value) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^www\./, ""),
  )
  .refine((value) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(value), {
    message: "Must be a bare domain such as acme.io, not a URL",
  });

// Aliases are matched literally against answer text. A blank one would
// match nothing (the extractor skips it), so reject it here rather than
// storing a value that silently does nothing.
const aliasSchema = z.string().min(1).max(200);

export const createBrandSchema = z.object({
  name: z.string().min(1).max(200),
  aliases: z.array(aliasSchema).max(50).default([]),
  domains: z.array(domainSchema).max(50).default([]),
  isOwn: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

export const updateBrandSchema = z
  .object({
    name: z.string().min(1).max(200),
    aliases: z.array(aliasSchema).max(50),
    domains: z.array(domainSchema).max(50),
    isOwn: z.boolean(),
    enabled: z.boolean(),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one field to update",
  });

export const resultsQuerySchema = z.object({
  promptId: z.uuid().optional(),
  engine: z.enum(ENGINES).optional(),
  status: z.enum(["pending", "completed", "failed"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  include: z.literal("response").optional(),
});

export const idSchema = z.uuid();

export type CreatePromptInput = z.infer<typeof createPromptSchema>;
export type UpdatePromptInput = z.infer<typeof updatePromptSchema>;
export type CreateBrandInput = z.infer<typeof createBrandSchema>;
export type UpdateBrandInput = z.infer<typeof updateBrandSchema>;
export type ResultsQuery = z.infer<typeof resultsQuerySchema>;
