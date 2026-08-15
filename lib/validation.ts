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
export type ResultsQuery = z.infer<typeof resultsQuerySchema>;
