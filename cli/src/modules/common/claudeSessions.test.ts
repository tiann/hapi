import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
    listLocalClaudeSessionSummaries,
    listLocalClaudeSessionsWithMessagesByIds,
    readClaudeSessionEntries
} from './claudeSessions'

const SESSION_ID = '06992c9a-1234-5678-9abc-def012345678'

function writeSubagent(projectDir: string, sessionId: string, name: string, toolUseId: string, lines: unknown[]): void {
    const subagentsDir = join(projectDir, sessionId, 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    writeFileSync(join(subagentsDir, `${name}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'))
    writeFileSync(join(subagentsDir, `${name}.meta.json`), JSON.stringify({ toolUseId }))
}

function writeMainTranscript(projectDir: string, sessionId: string, lines: unknown[]): void {
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'))
}

function userEntry(uuid: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'user',
        uuid,
        timestamp: '2026-11-13T00:00:00.000Z',
        cwd: '/tmp/project',
        message: { role: 'user', content: text },
        ...extra
    }
}

function assistantEntry(uuid: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        type: 'assistant',
        uuid,
        timestamp: '2026-11-13T00:00:05.000Z',
        cwd: '/tmp/project',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        ...extra
    }
}

describe('local Claude session reader', () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR
    let root = ''

    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true })
        root = ''
        if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir
    })

    function makeProject(): string {
        root = mkdtempSync(join(tmpdir(), 'claude-home-'))
        process.env.CLAUDE_CONFIG_DIR = root
        const projectDir = join(root, 'projects', '-tmp-project')
        mkdirSync(projectDir, { recursive: true })
        return projectDir
    }

    it('splices subagent batches before their tool_result and filters meta and injected rows', async () => {
        const projectDir = makeProject()
        writeMainTranscript(projectDir, SESSION_ID, [
            { type: 'summary', summary: 'Continued from an earlier conversation', leafUuid: 'u4' },
            { type: 'ai-title', aiTitle: 'E2E run title' },
            userEntry('u1', 'hello there'),
            assistantEntry('u2', 'Starting the search'),
            // Subagent transcript (matched through meta.json toolUseId).
            { type: 'user', uuid: 'u3', timestamp: '2026-11-13T00:00:10.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } },
            assistantEntry('u4', 'All done'),
            // Filtered rows: meta injection, system-reminder injection.
            userEntry('u5', 'meta noise', { isMeta: true }),
            userEntry('u6', '<system-reminder>background task</system-reminder>'),
            // Visible system subtype stays importable.
            { type: 'system', uuid: 'u7', subtype: 'api_error', timestamp: '2026-11-13T00:00:20.000Z', error: 'rate limited' }
        ])
        writeSubagent(projectDir, SESSION_ID, 'agent-a', 'tool-1', [
            { type: 'user', uuid: 's1', isSidechain: true, timestamp: '2026-11-13T00:00:07.000Z', message: { role: 'user', content: 'scanning files' } },
            { type: 'assistant', uuid: 's2', isSidechain: true, timestamp: '2026-11-13T00:00:08.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'found matches' }] } }
        ])
        // No main entry carries this tool_use id: batch lands at the end.
        writeSubagent(projectDir, SESSION_ID, 'agent-b', 'tool-missing', [
            { type: 'user', uuid: 'b1', isSidechain: true, timestamp: '2026-11-13T00:00:09.000Z', message: { role: 'user', content: 'orphan scan' } },
            assistantEntry('b2', 'orphan result', { isSidechain: true })
        ])
        // Non-agent files in the subagents dir are ignored.
        mkdirSync(join(projectDir, SESSION_ID, 'subagents'), { recursive: true })
        writeFileSync(join(projectDir, SESSION_ID, 'subagents', 'notes.txt'), 'ignore me')

        const entries = await readClaudeSessionEntries(join(projectDir, `${SESSION_ID}.jsonl`))
        // u5 (isMeta) drops; u6 (system-reminder user row) stays, matching the
        // live replay where non-external user rows go out as agent payloads.
        expect(entries.map((entry) => ('uuid' in entry ? entry.uuid : '<no-uuid>'))).toEqual([
            'u1', 'u2', 's1', 's2', 'u3', 'u4', 'u6', 'u7', 'b1', 'b2'
        ])
        // Subagent sidechain rows are marked sidechain and carry the parent
        // tool_use id from meta.json so the web tracer can group them.
        const spliced = entries[2]!
        expect(spliced.isSidechain).toBe(true)
        expect(spliced.parentToolUseId).toBe('tool-1')

        const summaries = await listLocalClaudeSessionSummaries()
        expect(summaries).toHaveLength(1)
        expect(summaries[0]!.id).toBe(SESSION_ID)
        expect(summaries[0]!.title).toBe('E2E run title')
        // Only genuinely typed user text counts: meta and injected rows are
        // not user prompts.
        expect(summaries[0]!.lastUserMessage).toBe('hello there')
        expect(summaries[0]!.cwd).toBe('/tmp/project')
        expect(summaries[0]!.messageCount).toBe(10)

        const sessions = await listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID]))
        expect(sessions).toHaveLength(1)
        const messages = sessions[0]!.messages
        expect(messages).toHaveLength(10)
        expect(messages.map((message) => message.uuid)).toEqual([
            'u1', 'u2', 's1', 's2', 'u3', 'u4', 'u6', 'u7', 'b1', 'b2'
        ])
        // External user text keeps the live replay shape...
        expect(messages[0]!.content).toEqual({
            role: 'user',
            content: { type: 'text', text: 'hello there' },
            meta: { sentFrom: 'cli' }
        })
        expect(messages[0]!.createdAt).toBe(Date.parse('2026-11-13T00:00:00.000Z'))
        // ...everything else is the raw entry as the agent 'output' payload.
        expect(messages[1]!.content.role).toBe('agent')
        expect(messages[1]!.content.content).toMatchObject({ type: 'output', data: { type: 'assistant', uuid: 'u2' } })
        // Sidechain user rows are agent payload, not user input.
        expect(messages[2]!.content.role).toBe('agent')
        // tool_result rows are agent payload too (they carry no user text).
        expect(messages[4]!.content.role).toBe('agent')
        expect(messages[4]!.content.content).toMatchObject({ type: 'output', data: { uuid: 'u3' } })
    })

    it('falls back to first user text for the title and skips sessions without importable rows', async () => {
        const projectDir = makeProject()
        writeMainTranscript(projectDir, SESSION_ID, [
            userEntry('u1', 'Fix the flaky e2e test'),
            assistantEntry('u2', 'On it')
        ])
        const otherId = '11111111-2222-3333-4444-555555555555'
        writeMainTranscript(projectDir, otherId, [
            { type: 'summary', summary: 'nothing importable', leafUuid: 'x' }
        ])

        const summaries = await listLocalClaudeSessionSummaries()
        expect(summaries).toHaveLength(1)
        expect(summaries[0]!.id).toBe(SESSION_ID)
        expect(summaries[0]!.title).toBe('Fix the flaky e2e test')
        expect(summaries[0]!.messageCount).toBe(2)

        const sessions = await listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID, otherId]))
        expect(sessions).toHaveLength(1)
        expect(sessions[0]!.id).toBe(SESSION_ID)
    })

    it('returns empty lists when no Claude config dir exists', async () => {
        makeProject()
        rmSync(join(root, 'projects'), { recursive: true, force: true })
        expect(await listLocalClaudeSessionSummaries()).toEqual([])
        expect(await listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID]))).toEqual([])
    })

    it('deduplicates a session id kept in two project dirs, scanning only the newest file', async () => {
        const projectDir = makeProject()
        writeMainTranscript(projectDir, SESSION_ID, [userEntry('u1', 'newest copy')])
        // Claude Code keeps a stale copy behind when a session moves between
        // project dirs (worktree enter/leave).
        const olderDir = join(root, 'projects', '-tmp-project-old')
        mkdirSync(olderDir, { recursive: true })
        writeMainTranscript(olderDir, SESSION_ID, [userEntry('u1', 'oldest copy')])
        utimesSync(join(olderDir, `${SESSION_ID}.jsonl`), new Date(1000), new Date(1000))
        utimesSync(join(projectDir, `${SESSION_ID}.jsonl`), new Date(2000), new Date(2000))

        const summaries = await listLocalClaudeSessionSummaries()
        expect(summaries).toHaveLength(1)
        expect(summaries[0]!.file).toBe(join(projectDir, `${SESSION_ID}.jsonl`))
        expect(summaries[0]!.lastUserMessage).toBe('newest copy')

        const sessions = await listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID]))
        expect(sessions).toHaveLength(1)
        expect(sessions[0]!.messages[0]!.content).toMatchObject({ content: { text: 'newest copy' } })
    })

    it('drops entries with an empty uuid from the imported messages', async () => {
        const projectDir = makeProject()
        writeMainTranscript(projectDir, SESSION_ID, [
            userEntry('u1', 'kept'),
            { type: 'user', uuid: '', timestamp: '2026-11-13T00:00:02.000Z', message: { role: 'user', content: 'empty uuid row' } },
            assistantEntry('u2', 'also kept')
        ])

        const sessions = await listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID]))
        // An empty uuid would fail the hub's anchor validation for the whole
        // machine import: the row is dropped instead.
        expect(sessions[0]!.messages.map((message) => message.uuid)).toEqual(['u1', 'u2'])
    })

    it('counts and lists only rows that import, so empty-uuid sessions are not offered', async () => {
        const projectDir = makeProject()
        writeMainTranscript(projectDir, SESSION_ID, [
            userEntry('u1', 'kept'),
            { type: 'user', uuid: '', timestamp: '2026-11-13T00:00:02.000Z', message: { role: 'user', content: 'empty uuid row' } },
            assistantEntry('u2', 'also kept')
        ])
        const emptyOnly = '16992c9a-1234-5678-9abc-def012345678'
        writeMainTranscript(projectDir, emptyOnly, [
            { type: 'user', uuid: ' ', timestamp: '2026-11-13T00:00:02.000Z', message: { role: 'user', content: 'no usable uuid' } }
        ])

        const summaries = await listLocalClaudeSessionSummaries()
        expect(summaries.map((summary) => summary.id)).toEqual([SESSION_ID])
        expect(summaries[0]!.messageCount).toBe(2)
    })

    it('lists at most the 200 newest sessions, like the other local sources', async () => {
        const projectDir = makeProject()
        // One more session than an import request may carry.
        for (let index = 0; index < 201; index += 1) {
            const sessionId = `${String(index).padStart(8, '0')}-1234-5678-9abc-def012345678`
            writeMainTranscript(projectDir, sessionId, [userEntry(`u-${index}`, `session ${index}`)])
            utimesSync(join(projectDir, `${sessionId}.jsonl`), 1_000 + index, 1_000 + index)
        }

        const summaries = await listLocalClaudeSessionSummaries()
        expect(summaries).toHaveLength(200)
        // Newest first; the oldest session is the one left out.
        expect(summaries[0]!.lastUserMessage).toBe('session 200')
        expect(summaries.map((summary) => summary.lastUserMessage)).not.toContain('session 0')
    })

    it('picks the same copy of a duplicated session id on every scan when mtimes tie', async () => {
        makeProject()
        const firstDir = join(root, 'projects', '-tmp-a')
        const secondDir = join(root, 'projects', '-tmp-b')
        mkdirSync(firstDir, { recursive: true })
        mkdirSync(secondDir, { recursive: true })
        writeMainTranscript(firstDir, SESSION_ID, [userEntry('u1', 'copy a')])
        writeMainTranscript(secondDir, SESSION_ID, [userEntry('u1', 'copy b')])
        utimesSync(join(firstDir, `${SESSION_ID}.jsonl`), 1_000, 1_000)
        utimesSync(join(secondDir, `${SESSION_ID}.jsonl`), 1_000, 1_000)

        const summaries = await listLocalClaudeSessionSummaries()
        expect(summaries.map((summary) => summary.file)).toEqual([join(firstDir, `${SESSION_ID}.jsonl`)])
    })

    it('compares raw mtimes so a sub-millisecond newer copy still wins', async () => {
        makeProject()
        // The newer copy sits in the dir that sorts last, so neither path
        // order nor directory listing order can pick it by accident.
        const olderDir = join(root, 'projects', '-tmp-a')
        const newerDir = join(root, 'projects', '-tmp-b')
        mkdirSync(newerDir, { recursive: true })
        mkdirSync(olderDir, { recursive: true })
        writeMainTranscript(newerDir, SESSION_ID, [userEntry('u1', 'newer copy')])
        writeMainTranscript(olderDir, SESSION_ID, [userEntry('u1', 'older copy')])
        // Both round to the same millisecond.
        utimesSync(join(olderDir, `${SESSION_ID}.jsonl`), 1_000.0002, 1_000.0002)
        utimesSync(join(newerDir, `${SESSION_ID}.jsonl`), 1_000.0004, 1_000.0004)

        const summaries = await listLocalClaudeSessionSummaries()
        expect(summaries.map((summary) => summary.lastUserMessage)).toEqual(['newer copy'])
    })

    it('splices subagent batches through their native parentToolUseId without meta.json', async () => {
        const projectDir = makeProject()
        writeMainTranscript(projectDir, SESSION_ID, [
            userEntry('u1', 'hello there'),
            { type: 'user', uuid: 'u2', timestamp: '2026-11-13T00:00:10.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } }
        ])
        // No sibling meta.json: newer Claude Code writes the parent tool_use
        // id on every sidechain entry itself.
        const subagentsDir = join(projectDir, SESSION_ID, 'subagents')
        mkdirSync(subagentsDir, { recursive: true })
        writeFileSync(join(subagentsDir, 'agent-a.jsonl'), [
            JSON.stringify({ type: 'user', uuid: 's1', isSidechain: true, parentToolUseId: 'tool-1', timestamp: '2026-11-13T00:00:07.000Z', message: { role: 'user', content: 'scanning files' } }),
            JSON.stringify({ type: 'assistant', uuid: 's2', isSidechain: true, parentToolUseId: 'tool-1', timestamp: '2026-11-13T00:00:08.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'found matches' }] } })
        ].join('\n'))

        const entries = await readClaudeSessionEntries(join(projectDir, `${SESSION_ID}.jsonl`))
        expect(entries.map((entry) => ('uuid' in entry ? entry.uuid : '<no-uuid>'))).toEqual(['u1', 's1', 's2', 'u2'])
        expect((entries[1] as { parentToolUseId?: string }).parentToolUseId).toBe('tool-1')
    })

    it('orders unmatched subagent batches by first-entry timestamp, not readdir order', async () => {
        const projectDir = makeProject()
        writeMainTranscript(projectDir, SESSION_ID, [userEntry('u1', 'solo')])
        const subagentsDir = join(projectDir, SESSION_ID, 'subagents')
        mkdirSync(subagentsDir, { recursive: true })
        // Written first but stamped later: timestamp order must beat the OS
        // directory order so re-imports stay position-stable.
        writeFileSync(join(subagentsDir, 'agent-a.jsonl'), JSON.stringify({ type: 'user', uuid: 'late-1', isSidechain: true, timestamp: '2026-11-13T00:00:20.000Z', message: { role: 'user', content: 'late batch' } }))
        writeFileSync(join(subagentsDir, 'agent-z.jsonl'), JSON.stringify({ type: 'user', uuid: 'early-1', isSidechain: true, timestamp: '2026-11-13T00:00:10.000Z', message: { role: 'user', content: 'early batch' } }))

        const entries = await readClaudeSessionEntries(join(projectDir, `${SESSION_ID}.jsonl`))
        expect(entries.map((entry) => ('uuid' in entry ? entry.uuid : '<no-uuid>'))).toEqual(['u1', 'early-1', 'late-1'])
    })
})