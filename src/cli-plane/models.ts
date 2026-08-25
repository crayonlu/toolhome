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

const cliCredentialBindingsValueSchema = z.record(z.string().min(1), z.string().min(1));
export const cliCredentialBindingsSchema = cliCredentialBindingsValueSchema.default({});

const cliAuthStrategyValueSchema = z.enum([
  'none',
  'azure-service-principal',
  'tailscale-auth-key',
]);
export const cliAuthStrategySchema = cliAuthStrategyValueSchema.default('none');

const namedVolumeSourceSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Only Docker named volumes are supported');

const containerVolumeSchema = z.object({
  source: namedVolumeSourceSchema,
  target: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (value) => value.startsWith('/') && !/[\0\r\n:]/.test(value),
      'Container volume targets must be absolute paths without control characters or colons',
    ),
  readOnly: z.boolean().default(false),
});

export const cliRuntimeConfigSchema = z
  .object({
    executionMode: z.enum(['host', 'docker']),
    authStrategy: cliAuthStrategySchema,
    containerVolumes: z.array(containerVolumeSchema).max(16),
  })
  .superRefine((value, context) => {
    if (value.executionMode === 'host' && value.authStrategy !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['authStrategy'],
        message: 'Authentication bootstrap requires Docker execution mode',
      });
    }
    if (value.executionMode === 'host' && value.containerVolumes.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['containerVolumes'],
        message: 'Container volumes require Docker execution mode',
      });
    }
    const targets = new Set<string>();
    for (const [index, volume] of value.containerVolumes.entries()) {
      if (targets.has(volume.target)) {
        context.addIssue({
          code: 'custom',
          path: ['containerVolumes', index, 'target'],
          message: 'Container volume targets must be unique',
        });
      }
      targets.add(volume.target);
    }
  });

export const createCliInputSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(120),
    command: z.string().min(1).max(1024),
    executionMode: z.enum(['host', 'docker']).default('host'),
    entrypoint: z.string().min(1).max(256).nullable().default(null),
    authStrategy: cliAuthStrategySchema,
    containerVolumes: z.array(containerVolumeSchema).default([]),
    platform: z.string().min(1).max(120).nullable().default(null),
    allowList: cliAllowListSchema.default({ allow: [], deny: [] }),
    interactive: z.boolean().default(false),
    credentialId: z.string().nullable().default(null),
    credentialBindings: cliCredentialBindingsSchema,
    probe: cliProbeSchema.nullable().default(null),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(100).max(3_600_000).default(60_000),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(64 * 1024),
  })
  .superRefine((value, context) => {
    const result = cliRuntimeConfigSchema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({
          code: issue.code === 'custom' ? 'custom' : 'custom',
          path: issue.path,
          message: issue.message,
        });
      }
    }
  });

export const updateCliInputSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  command: z.string().min(1).max(1024).optional(),
  executionMode: z.enum(['host', 'docker']).optional(),
  entrypoint: z.string().min(1).max(256).nullable().optional(),
  authStrategy: cliAuthStrategyValueSchema.optional(),
  containerVolumes: z.array(containerVolumeSchema).optional(),
  platform: z.string().min(1).max(120).nullable().optional(),
  allowList: cliAllowListSchema.optional(),
  interactive: z.boolean().optional(),
  credentialId: z.string().nullable().optional(),
  credentialBindings: cliCredentialBindingsValueSchema.optional(),
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

export function assertCliRuntimeConfig(value: {
  executionMode: 'host' | 'docker';
  authStrategy: 'none' | 'azure-service-principal' | 'tailscale-auth-key';
  containerVolumes: { source: string; target: string; readOnly: boolean }[];
}): void {
  cliRuntimeConfigSchema.parse(value);
}

export const cliRecordSchema = z.object({
  id: z.uuid(),
  slug: slugSchema,
  name: z.string(),
  command: z.string(),
  executionMode: z.enum(['host', 'docker']),
  entrypoint: z.string().min(1).max(256).nullable(),
  authStrategy: cliAuthStrategySchema,
  containerVolumes: z.array(containerVolumeSchema),
  platform: z.string().min(1).max(120).nullable(),
  allowList: cliAllowListSchema,
  interactive: z.boolean(),
  credentialId: z.string().nullable(),
  credentialBindings: cliCredentialBindingsSchema,
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
export type CliCredentialBindings = z.infer<typeof cliCredentialBindingsSchema>;
export type CliAuthStrategy = z.infer<typeof cliAuthStrategySchema>;
export type CliContainerVolume = z.infer<typeof cliRecordSchema>['containerVolumes'][number];
export type CliProbe = z.infer<typeof cliProbeSchema>;
export type CliRecord = z.infer<typeof cliRecordSchema>;
export type CreateCliInput = z.infer<typeof createCliInputSchema>;
export type UpdateCliInput = z.infer<typeof updateCliInputSchema>;
export type CliExecInput = z.infer<typeof cliExecInputSchema>;
