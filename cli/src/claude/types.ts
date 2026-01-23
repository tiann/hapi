/**
 * Schema validates fields used in the codebase and keeps explicit
 * log fields required by the CLI and UI.
 */

import { z } from "zod";

// Usage statistics for assistant messages - used in apiSession.ts
export const UsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  cache_read_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative(),
  service_tier: z.string().optional(),
});

const RawMessageSchema = z.object({
  role: z.string().optional(),
  content: z.unknown(),
  usage: UsageSchema.optional(),
});

const RawJSONLinesBaseSchema = z.object({
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  userType: z.string().optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
  version: z.string().optional(),
  gitBranch: z.string().optional(),
  timestamp: z.string().optional(),
});

// Main schema with validation for the fields used in the app
// NOTE: Schema remains lenient on message content to handle SDK variations
export const RawJSONLinesSchema = z.discriminatedUnion("type", [
  // User message - validates uuid and message.content
  RawJSONLinesBaseSchema.extend({
    type: z.literal("user"),
    uuid: z.string(),
    message: RawMessageSchema,
    mode: z.string().optional(),
    toolUseResult: z.unknown().optional(),
  }),

  // Assistant message - only validates uuid and type
  // message object is optional to handle synthetic error messages
  RawJSONLinesBaseSchema.extend({
    uuid: z.string(),
    type: z.literal("assistant"),
    message: RawMessageSchema.optional(),
    requestId: z.string().optional(),
  }),

  // Summary message - validates summary and leafUuid
  RawJSONLinesBaseSchema.extend({
    type: z.literal("summary"),
    summary: z.string(),
    leafUuid: z.string(),
  }),

  // System message - validates uuid and subtype data used by the UI
  RawJSONLinesBaseSchema.extend({
    type: z.literal("system"),
    uuid: z.string(),
    subtype: z.string().optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    session_id: z.string().optional(),
    retryAttempt: z.number().optional(),
    maxRetries: z.number().optional(),
    error: z.unknown().optional(),
    durationMs: z.number().optional(),
  }),
]);

export type RawJSONLines = z.infer<typeof RawJSONLinesSchema>;
