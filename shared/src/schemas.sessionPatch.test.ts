import { describe, expect, it } from 'vitest';
import { SessionPatchSchema } from './schemas';

// Guard the contract for the second-half-of-#884 fix. The web client routes
// `session-updated` events to the structured-patch path only when the event's
// `data` parses as a SessionPatch — these tests pin the schema shape so a
// future refactor that drops `.strict()`, the versioned (version, value)
// wrappers, or any of the new optional fields breaks the build instead of
// silently re-introducing the refetch storm.
describe('SessionPatchSchema structured patches (closes #884 follow-up)', () => {
    it('parses a versioned todos patch', () => {
        const parsed = SessionPatchSchema.safeParse({
            todos: {
                version: 10,
                value: [{ content: 'thing', status: 'pending' }]
            }
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects bare todos without a version (dual-SSE watermark required)', () => {
        const parsed = SessionPatchSchema.safeParse({
            todos: [{ content: 'thing', status: 'pending' }]
        });
        expect(parsed.success).toBe(false);
    });

    it('parses a versioned teamState patch', () => {
        const parsed = SessionPatchSchema.safeParse({
            teamState: {
                version: 11,
                value: {
                    teamName: 'crew',
                    members: [{ name: 'one' }]
                }
            }
        });
        expect(parsed.success).toBe(true);
    });

    it('parses a teamState clear patch (null value = TeamDelete)', () => {
        // PR #897 review (HAPI Bot, 2026-06-13 Major + 2026-07-30 Major):
        // teamState travels as { version, value }; value null clears the
        // cached row. Version gates dual-SSE reordering.
        const parsed = SessionPatchSchema.safeParse({
            teamState: { version: 12, value: null }
        });
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.teamState?.value).toBeNull();
        }
    });

    it('parses a versioned metadata patch', () => {
        const parsed = SessionPatchSchema.safeParse({
            metadata: {
                version: 7,
                value: { path: '/tmp', host: 'h' }
            }
        });
        expect(parsed.success).toBe(true);
    });

    it('parses a versioned agentState patch with null value', () => {
        const parsed = SessionPatchSchema.safeParse({
            agentState: { version: 3, value: null }
        });
        expect(parsed.success).toBe(true);
    });

    it('rejects metadata without a version (must stay versioned for cache safety)', () => {
        const parsed = SessionPatchSchema.safeParse({
            metadata: { value: { path: '/tmp', host: 'h' } }
        });
        expect(parsed.success).toBe(false);
    });

    it('stays strict and rejects unknown keys (catches silent .strict() removal)', () => {
        const parsed = SessionPatchSchema.safeParse({
            todos: { version: 1, value: [] },
            notARealField: true
        });
        expect(parsed.success).toBe(false);
    });

    it('rejects a full Session payload (full-session SSE goes through isSessionRecord instead)', () => {
        const fullSession = {
            id: 's1',
            namespace: 'default',
            seq: 1,
            createdAt: 1,
            updatedAt: 1,
            active: true,
            activeAt: 1,
            metadata: null,
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            thinking: false,
            thinkingAt: 0
        };
        expect(SessionPatchSchema.safeParse(fullSession).success).toBe(false);
    });
});
