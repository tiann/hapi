import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildTurnContexts, childIdentity } from './childMetadata';

const entry = (type: string, payload: unknown) => `${JSON.stringify({ type, payload })}\n`;
describe('child execution evidence', () => {
    it('accepts exact child/turn context and never thread settings or parent evidence', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-child-context-'));
        try {
            const path = join(dir, 'rollout.jsonl');
            await writeFile(path, entry('session_meta', { id: 'child' }) + entry('turn_context', { turn_id: 'old', model: 'a', effort: 'high' }));
            const reader = new ChildTurnContexts('child'); reader.setPath(path);
            expect(await reader.read('next')).toBeUndefined();
            expect(await reader.read('old')).toMatchObject({ turnId: 'old', model: 'a', reasoningEffort: 'high' });
            await appendFile(path, entry('turn_context', { turn_id: 'next', model: 'b' }));
            expect(await reader.read('next')).toMatchObject({ model: 'b', reasoningEffort: null });
            const replacement = join(dir, 'replacement');
            await writeFile(replacement, entry('session_meta', { id: 'parent' }) + entry('turn_context', { turn_id: 'old', model: 'wrong-parent', effort: 'medium' }));
            await rename(replacement, path);
            expect(await reader.read('old')).toBeUndefined();
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it('waits for complete JSON lines and recovers from truncation', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-child-context-'));
        try {
            const path = join(dir, 'rollout.jsonl'); const reader = new ChildTurnContexts('child'); reader.setPath(path);
            await writeFile(path, entry('session_meta', { id: 'child' }) + '{"type":"turn_context",');
            expect(await reader.read('t')).toBeUndefined();
            await appendFile(path, '"payload":{"turn_id":"t","model":"native","effort":"low"}}\n');
            expect(await reader.read('t')).toMatchObject({ model: 'native', reasoningEffort: 'low' });
            await writeFile(path, entry('session_meta', { id: 'other' }));
            expect(await reader.read('t')).toBeUndefined();
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it('takes task leaf and standalone role from native identity, never thread title or filesystem path', () => {
        expect(childIdentity({ name: 'invented role', path: '/disk/file', model: 'parent', source: { subAgent: { thread_spawn: {
            agent_path: '/root/review_298', agent_nickname: 'Aristotle', agent_role: 'reviewer' } } } })).toEqual({
                taskName: 'review_298', agentPath: '/root/review_298', nickname: 'Aristotle', role: 'reviewer' });
        expect(childIdentity({ name: 'analyst', path: '/disk/file', source: 'unknown' })).toEqual({});
    });
});

it('recovers exact archived child context from a stale native pre-archive path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-child-archive-'));
    try {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(dir, 'archived_sessions'));
        const path = join(dir, 'sessions', '2026', '10', '07', 'rollout.jsonl');
        await writeFile(join(dir, 'archived_sessions', 'rollout.jsonl'), entry('session_meta', { id: 'child' }) + entry('turn_context', { turn_id: 't', model: 'archived-actual', effort: 'low' }));
        const reader = new ChildTurnContexts('child'); reader.setPath(path);
        expect(await reader.read('t')).toMatchObject({ model: 'archived-actual', reasoningEffort: 'low' });
        const other = new ChildTurnContexts('other'); other.setPath(path);
        expect(await other.read('t')).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
});

describe('full-history child rollout provenance', () => {
    it('binds the first file header and separates several ancestor turns from own contexts in either anchor order', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-child-inherited-'));
        try {
            const path = join(dir, 'rollout.jsonl');
            await writeFile(path,
                entry('session_meta', { id: 'child', forked_from_id: 'parent', parent_thread_id: 'parent', subagent_history_start_ordinal: 9 })
                + entry('session_meta', { id: 'grandparent' })
                + entry('turn_context', { turn_id: 'grandparent-turn', root_turn_id: 'root', model: 'grandparent-model', effort: 'high' })
                + entry('token_usage_record', { thread_id: 'grandparent', turn_id: 'grandparent-turn' })
                + entry('session_meta', { id: 'parent' })
                + entry('event_msg', { type: 'task_started', turn_id: 'parent-turn', root_turn_id: 'root' })
                + entry('turn_context', { turn_id: 'parent-turn', root_turn_id: 'root', model: 'parent-model', effort: 'medium' })
                + entry('event_msg', { type: 'item_completed', thread_id: 'parent', turn_id: 'parent-turn' })
                + entry('event_msg', { type: 'thread_settings_applied', thread_id: 'child' })
                + entry('event_msg', { type: 'task_started', turn_id: 'own-turn', root_turn_id: 'root' })
                + entry('turn_context', { turn_id: 'own-turn', root_turn_id: 'root', model: 'child-model', effort: 'low' }));
            const reader = new ChildTurnContexts('child'); reader.setPath(path);
            expect(await reader.read('own-turn')).toBeUndefined();
            expect(await reader.read('own-turn', 'parent')).toBeUndefined();
            expect(await reader.read('own-turn', 'child')).toMatchObject({ model: 'child-model', reasoningEffort: 'low' });
            expect(await reader.read('parent-turn')).toBeUndefined();
            expect(await reader.read('grandparent-turn')).toBeUndefined();
            // The real persisted item event arrives after turn_context; task_started alone lacks thread ownership.
            await appendFile(path, entry('event_msg', { type: 'item_completed', thread_id: 'child', turn_id: 'own-turn' }));
            expect(await reader.read('own-turn')).toMatchObject({ model: 'child-model', reasoningEffort: 'low' });
            // A replayed ancestor header is inherited content, not a change of file owner.
            await appendFile(path, entry('session_meta', { id: 'parent' })
                + entry('token_usage_record', { thread_id: 'child', turn_id: 'second-own-turn', root_turn_id: 'root' })
                + entry('turn_context', { turn_id: 'second-own-turn', root_turn_id: 'root', model: 'second-child-model', effort: 'medium' }));
            expect(await reader.read('second-own-turn')).toMatchObject({ model: 'second-child-model', reasoningEffort: 'medium' });
            const replay = new ChildTurnContexts('child'); replay.setPath(path);
            expect(await replay.read('own-turn')).toEqual(await reader.read('own-turn'));
            expect(await replay.read('parent-turn')).toBeUndefined();
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it.each([entry('session_meta', { id: 'wrong' }), '{malformed}\n', entry('turn_context', { turn_id: 't', model: 'wrong' })])
    ('never repairs an invalid first owner using a later matching header (%s)', async first => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-child-first-owner-'));
        try {
            const path = join(dir, 'rollout.jsonl');
            await writeFile(path, first + entry('session_meta', { id: 'child' })
                + entry('token_usage_record', { thread_id: 'child', turn_id: 't' })
                + entry('turn_context', { turn_id: 't', model: 'untrusted', effort: 'high' }));
            const reader = new ChildTurnContexts('child'); reader.setPath(path);
            expect(await reader.read('t', 'child')).toBeUndefined();
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
    it('clears file-derived own-turn anchors after replacement and recovers exact archived full-history files', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'hapi-child-anchor-reset-'));
        try {
            const { mkdir } = await import('node:fs/promises');
            const path = join(dir, 'rollout.jsonl');
            const context = entry('session_meta', { id: 'child', forked_from_id: 'parent' })
                + entry('session_meta', { id: 'parent' }) + entry('turn_context', { turn_id: 't', model: 'child', effort: 'low' });
            await writeFile(path, context + entry('token_usage_record', { thread_id: 'child', turn_id: 't' }));
            const reader = new ChildTurnContexts('child'); reader.setPath(path);
            expect(await reader.read('t')).toMatchObject({ model: 'child' });
            const next = join(dir, 'next'); await writeFile(next, context); await rename(next, path);
            expect(await reader.read('t')).toBeUndefined();
            await mkdir(join(dir, 'archived_sessions'));
            const archived = join(dir, 'archived_sessions', 'archived.jsonl');
            await writeFile(archived, context + entry('event_msg', { type: 'item_completed', thread_id: 'child', turn_id: 't' }));
            reader.setPath(join(dir, 'sessions', 'archived.jsonl'));
            expect(await reader.read('t')).toMatchObject({ model: 'child', reasoningEffort: 'low' });
            const other = new ChildTurnContexts('other'); other.setPath(join(dir, 'sessions', 'archived.jsonl'));
            expect(await other.read('t')).toBeUndefined();
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});
