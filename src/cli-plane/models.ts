import { z } from 'zod';
import { slugSchema } from '../domain/models.js';

/**
 * CLI plane record schemas (Form A of docs/cli-hosting-research.md).
 *
 * A CLI is a first-class entity: a command or container image plus a declarative
 * allow-list, optional probe for status checks, and an optional Env Credential
 * whose variables are injected into every execution.
 */

/** One argv rule: token patterns, where `*` matches a single argv token. */
export const cliAllowRuleSchema = z.array(z.string().min(1)).min(1);

export const cliAllowListSchema = z.object({
  allow: z.array(cliAllowRuleSchema).default([]),
  deny: z.array(cliAllowRuleSchema).default([]),
});

export const cliProbeSchema = z.object({
  command: z.string().min(1).max(1024),
  args: z.array(z.string()).default([]),
});

export const createCliInputSchema = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
  command: z.string().min(1).max(1024),
  executionMode: z.enum(['host', 'docker']).default('host'),
  allowList: cliAllowListSchema.default({ allow: [], deny: [] }),
  interactive: z.boolean().default(false),
  credentialId: z.string().nullable().default(null),
  probe: cliProbeSchema.nullable().default(null),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(100).max(3_600_000).default(60_000),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(64 * 1024),
});

export const updateCliInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  command: z.string().min(1).max(1024).optional(),
  executionMode: z.enum(['host', 'docker']).optional(),
  allowList: cliAllowListSchema.optional(),
  interactive: z.boolean().optional(),
  credentialId: z.string().nullable().optional(),
  probe: cliProbeSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .optional(),
});

export const cliRecordSchema = z.object({
  id: z.uuid(),
  slug: slugSchema,
  name: z.string(),
  command: z.string(),
  executionMode: z.enum(['host', 'docker']),
  allowList: cliAllowListSchema,
  interactive: z.boolean(),
  credentialId: z.string().nullable(),
  probe: cliProbeSchema.nullable(),
  enabled: z.boolean(),
  timeoutMs: z.number(),
  maxOutputBytes: z.number(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Per-exec request body. `argv` is an array only — never a shell string. */
export const cliExecInputSchema = z.object({
  argv: z.array(z.string()).min(1),
  stdin: z.string().nullable().optional(),
  timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .optional(),
});

export type CliAllowRule = z.infer<typeof cliAllowRuleSchema>;
export type CliAllowList = z.infer<typeof cliAllowListSchema>;
export type CliProbe = z.infer<typeof cliProbeSchema>;
export type CliRecord = z.infer<typeof cliRecordSchema>;
export type CreateCliInput = z.infer<typeof createCliInputSchema>;
export type UpdateCliInput = z.infer<typeof updateCliInputSchema>;
export type CliExecInput = z.infer<typeof cliExecInputSchema>;
