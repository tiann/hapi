import { describe, it, expect } from "vitest";
import { RawJSONLinesSchema } from "./types";

describe("RawJSONLinesSchema", () => {
    describe("system / turn_duration record", () => {
        it("preserves messageId so the web reducer can match the duration to the right block", () => {
            // Claude code emits turn_duration as a system record carrying the
            // assistant message uuid in `messageId`. If Zod strips that field,
            // the web matcher in normalizeAgent / reducerTimeline falls back
            // to "the last visible block" and can attach the duration to a
            // wrong block in interleaved/tool-heavy turns.
            const parsed = RawJSONLinesSchema.parse({
                type: "system",
                subtype: "turn_duration",
                uuid: "evt-1",
                durationMs: 4250,
                messageId: "assistant-uuid-42"
            });
            if (parsed.type !== "system") throw new Error("expected system record");
            expect(parsed.messageId).toBe("assistant-uuid-42");
            expect(parsed.durationMs).toBe(4250);
        });

        it("keeps messageId optional so legacy records without it still parse", () => {
            const parsed = RawJSONLinesSchema.parse({
                type: "system",
                subtype: "turn_duration",
                uuid: "evt-2",
                durationMs: 1000
            });
            if (parsed.type !== "system") throw new Error("expected system record");
            expect(parsed.messageId).toBeUndefined();
        });
    });

    describe("assistant record", () => {
        it("preserves message.model so the per-message model label can render", () => {
            const parsed = RawJSONLinesSchema.parse({
                type: "assistant",
                uuid: "msg-1",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "hi" }],
                    model: "claude-sonnet-4-6",
                    usage: { input_tokens: 3, output_tokens: 5 }
                }
            });
            if (parsed.type !== "assistant") throw new Error("expected assistant record");
            expect(parsed.message?.model).toBe("claude-sonnet-4-6");
        });
    });
});
