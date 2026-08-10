import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    CLAUDE_IMPORT_MIN_PAGE_BYTES,
    type ClaudeImportedMessage,
    type ClaudeLocalSessionSummary,
    type ClaudeLocalSessionWithMessages
} from '@hapi/protocol/apiTypes'
import {
    listLocalClaudeSessionMessagesPageById,
    listLocalClaudeSessionSummaries
} from './claudeSessions'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const CWD = '/tmp/claude-import-project'

function line(value: Record<string, unknown>): string {
    return JSON.stringify(value)
}

async function readSession(sessionId: string): Promise<ClaudeLocalSessionWithMessages | null> {
    let cursor = 0
    let summary: ClaudeLocalSessionSummary | null = null
    const messages: ClaudeImportedMessage[] = []
    while (true) {
        const page = await listLocalClaudeSessionMessagesPageById(
            sessionId,
            cursor,
            CLAUDE_IMPORT_MIN_PAGE_BYTES
        )
        if (!page) return null
        summary ??= page.session
        messages.push(...page.messages)
        if (page.nextCursor === null) return { ...summary, messages }
        cursor = page.nextCursor
    }
}

describe('local Claude sessions', () => {
    let tempDir: string
    let previousConfigDir: string | undefined

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'hapi-claude-sessions-'))
        previousConfigDir = process.env.CLAUDE_CONFIG_DIR
        process.env.CLAUDE_CONFIG_DIR = tempDir
        mkdirSync(join(tempDir, 'projects', '-tmp-claude-import-project'), {
            recursive: true
        })
    })

    afterEach(() => {
        if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
        else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
        rmSync(tempDir, { recursive: true, force: true })
    })

    it('lists main transcripts, converts visible history, and ignores subagent files', async () => {
        const projectDir = join(tempDir, 'projects', '-tmp-claude-import-project')
        writeFileSync(
            join(projectDir, `${SESSION_ID}.jsonl`),
            [
                line({
                    parentUuid: null,
                    isSidechain: false,
                    userType: 'external',
                    cwd: CWD,
                    sessionId: SESSION_ID,
                    type: 'user',
                    message: { role: 'user', content: 'First prompt' },
                    uuid: 'user-1',
                    timestamp: '2026-08-08T01:00:00.000Z'
                }),
                line({
                    parentUuid: 'user-1',
                    isSidechain: false,
                    cwd: CWD,
                    sessionId: SESSION_ID,
                    type: 'assistant',
                    message: {
                        role: 'assistant',
                        model: 'claude-sonnet-4-5',
                        content: [{ type: 'text', text: 'Answer' }]
                    },
                    uuid: 'assistant-1',
                    timestamp: '2026-08-08T01:00:01.000Z'
                }),
                line({
                    cwd: CWD,
                    sessionId: SESSION_ID,
                    type: 'user',
                    isMeta: true,
                    message: { role: 'user', content: 'hidden metadata' },
                    uuid: 'meta-1',
                    timestamp: '2026-08-08T01:00:02.000Z'
                }),
                line({
                    cwd: CWD,
                    sessionId: SESSION_ID,
                    type: 'ai-title',
                    aiTitle: 'Imported work'
                }),
                line({
                    type: 'custom-title',
                    customTitle: 'Renamed imported work',
                    sessionId: SESSION_ID
                })
            ].join('\n')
        )

        const subagentDir = join(projectDir, SESSION_ID, 'subagents')
        mkdirSync(subagentDir, { recursive: true })
        writeFileSync(
            join(subagentDir, 'agent-child.jsonl'),
            line({
                cwd: CWD,
                sessionId: 'agent-child',
                type: 'user',
                message: { role: 'user', content: 'child prompt' },
                uuid: 'child-user'
            })
        )

        expect(await listLocalClaudeSessionSummaries()).toEqual([
            expect.objectContaining({
                id: SESSION_ID,
                title: 'Renamed imported work',
                lastUserMessage: 'First prompt',
                cwd: CWD,
                model: 'claude-sonnet-4-5',
                messageCount: 2
            })
        ])

        const full = await readSession(SESSION_ID)
        expect(full?.messages).toEqual([
            expect.objectContaining({
                localId: `claude:${SESSION_ID}:user-1`,
                createdAt: Date.parse('2026-08-08T01:00:00.000Z'),
                content: expect.objectContaining({ role: 'user' })
            }),
            expect.objectContaining({
                localId: `claude:${SESSION_ID}:assistant-1`,
                createdAt: Date.parse('2026-08-08T01:00:01.000Z'),
                content: expect.objectContaining({ role: 'agent' })
            })
        ])
    })

    it('returns only requested session transcripts', async () => {
        const projectDir = join(tempDir, 'projects', '-tmp-claude-import-project')
        for (const id of [SESSION_ID, '22222222-2222-4222-8222-222222222222']) {
            writeFileSync(
                join(projectDir, `${id}.jsonl`),
                line({
                    parentUuid: null,
                    isSidechain: false,
                    userType: 'external',
                    cwd: CWD,
                    sessionId: id,
                    type: 'user',
                    message: { role: 'user', content: id },
                    uuid: `user-${id}`,
                    timestamp: '2026-08-08T01:00:00.000Z'
                })
            )
        }

        const session = await readSession(SESSION_ID)
        expect(session?.id).toBe(SESSION_ID)
    })

    it('preserves user prompt whitespace when reading transcript pages', async () => {
        const projectDir = join(tempDir, 'projects', '-tmp-claude-import-project')
        const prompt = '  indented prompt\n'
        writeFileSync(
            join(projectDir, `${SESSION_ID}.jsonl`),
            line({
                parentUuid: null,
                isSidechain: false,
                userType: 'external',
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'user',
                message: { role: 'user', content: prompt },
                uuid: 'user-whitespace',
                timestamp: '2026-08-08T01:00:00.000Z'
            })
        )

        const session = await readSession(SESSION_ID)

        expect(session?.messages[0]?.content).toMatchObject({
            role: 'user',
            content: { type: 'text', text: prompt }
        })
    })

    it('streams a large CRLF transcript below a byte budget without losing message order', async () => {
        const projectDir = join(tempDir, 'projects', '-tmp-claude-import-project')
        const records: Record<string, unknown>[] = [{
            parentUuid: null,
            isSidechain: false,
            userType: 'external',
            cwd: CWD,
            sessionId: SESSION_ID,
            type: 'user',
            message: { role: 'user', content: 'Start' },
            uuid: 'user-0'
        }]
        let parentUuid = 'user-0'
        for (let index = 1; index <= 4; index += 1) {
            const uuid = `assistant-${index}`
            records.push({
                parentUuid,
                isSidechain: false,
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: `${index}:${'界'.repeat(40 * 1024)}` }] },
                uuid
            })
            parentUuid = uuid
        }
        writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), records.map(line).join('\r\n'))

        expect(await listLocalClaudeSessionSummaries()).toEqual([
            expect.objectContaining({ id: SESSION_ID, messageCount: 5 })
        ])

        const localIds: string[] = []
        let cursor = 0
        let pageCount = 0
        while (true) {
            const page = await listLocalClaudeSessionMessagesPageById(SESSION_ID, cursor, CLAUDE_IMPORT_MIN_PAGE_BYTES)
            expect(page).not.toBeNull()
            pageCount += 1
            localIds.push(...page!.messages.map((message) => message.localId))
            expect(Buffer.byteLength(JSON.stringify({ success: true, mode: 'messages', page }), 'utf8'))
                .toBeLessThanOrEqual(CLAUDE_IMPORT_MIN_PAGE_BYTES)
            if (page!.nextCursor === null) break
            expect(page!.nextCursor).toBeGreaterThan(cursor)
            cursor = page!.nextCursor
        }

        expect(pageCount).toBeGreaterThan(1)
        expect(localIds).toEqual([
            `claude:${SESSION_ID}:user-0`,
            `claude:${SESSION_ID}:assistant-1`,
            `claude:${SESSION_ID}:assistant-2`,
            `claude:${SESSION_ID}:assistant-3`,
            `claude:${SESSION_ID}:assistant-4`
        ])
    })

    it('replaces a single aggregate-oversized agent record before transport', async () => {
        const projectDir = join(tempDir, 'projects', '-tmp-claude-import-project')
        writeFileSync(
            join(projectDir, `${SESSION_ID}.jsonl`),
            line({
                parentUuid: null,
                isSidechain: false,
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: Array.from({ length: 4 }, (_, index) => ({
                        type: 'text',
                        text: `${index}:${'x'.repeat(60 * 1024)}`
                    }))
                },
                uuid: 'assistant-large'
            })
        )

        const page = await listLocalClaudeSessionMessagesPageById(SESSION_ID, 0, CLAUDE_IMPORT_MIN_PAGE_BYTES)

        expect(page?.nextCursor).toBeNull()
        expect(JSON.stringify(page?.messages[0]?.content)).toContain('oversized imported Claude message omitted')
        expect(Buffer.byteLength(JSON.stringify({ success: true, mode: 'messages', page }), 'utf8'))
            .toBeLessThanOrEqual(CLAUDE_IMPORT_MIN_PAGE_BYTES)
    })

    it('imports only the active branch after a Claude rewind', async () => {
        const projectDir = join(tempDir, 'projects', '-tmp-claude-import-project')
        const transcript = [
            {
                parentUuid: null,
                isSidechain: false,
                userType: 'external',
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'user',
                message: { role: 'user', content: 'Shared prompt' },
                uuid: 'user-1'
            },
            {
                parentUuid: 'user-1',
                isSidechain: false,
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Shared answer' },
                        { type: 'tool_use', id: 'tool-active', name: 'Task', input: {} }
                    ]
                },
                uuid: 'assistant-1'
            },
            {
                parentUuid: null,
                isSidechain: true,
                parentToolUseId: 'tool-active',
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Active sidechain' }] },
                uuid: 'sidechain-active'
            },
            {
                parentUuid: 'assistant-1',
                isSidechain: false,
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'attachment',
                attachment: { filePath: '/tmp/context.txt' },
                uuid: 'attachment-common'
            },
            {
                parentUuid: 'attachment-common',
                isSidechain: false,
                userType: 'external',
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'user',
                message: { role: 'user', content: 'Abandoned prompt' },
                uuid: 'user-old'
            },
            {
                parentUuid: 'user-old',
                isSidechain: false,
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'assistant',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'Abandoned answer' },
                        { type: 'tool_use', id: 'tool-old', name: 'Task', input: {} }
                    ]
                },
                uuid: 'assistant-old'
            },
            {
                parentUuid: 'assistant-old',
                isSidechain: true,
                parentToolUseId: 'tool-old',
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Abandoned sidechain' }] },
                uuid: 'sidechain-old'
            },
            {
                parentUuid: 'attachment-common',
                isSidechain: false,
                userType: 'external',
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'user',
                message: { role: 'user', content: 'Replacement prompt' },
                uuid: 'user-new'
            },
            {
                parentUuid: 'user-new',
                isSidechain: false,
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'Replacement answer' }] },
                uuid: 'assistant-new'
            },
            {
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'system',
                subtype: 'turn_duration',
                durationMs: 1234,
                messageId: 'assistant-new',
                uuid: 'duration-new'
            }
        ]
        writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), transcript.map(line).join('\n'))

        const session = await readSession(SESSION_ID)
        expect(session?.messages.map((message) => message.localId)).toEqual([
            `claude:${SESSION_ID}:user-1`,
            `claude:${SESSION_ID}:assistant-1`,
            `claude:${SESSION_ID}:sidechain-active`,
            `claude:${SESSION_ID}:user-new`,
            `claude:${SESSION_ID}:assistant-new`,
            `claude:${SESSION_ID}:duration-new`
        ])
        expect(session).toMatchObject({
            lastUserMessage: 'Replacement prompt',
            messageCount: 6
        })
    })

    it('keeps linear history when legacy records have no parent links', async () => {
        const projectDir = join(tempDir, 'projects', '-tmp-claude-import-project')
        writeFileSync(
            join(projectDir, `${SESSION_ID}.jsonl`),
            [
                line({
                    userType: 'external',
                    cwd: CWD,
                    sessionId: SESSION_ID,
                    type: 'user',
                    message: { role: 'user', content: 'Legacy prompt' },
                    uuid: 'legacy-user'
                }),
                line({
                    cwd: CWD,
                    sessionId: SESSION_ID,
                    type: 'assistant',
                    message: { role: 'assistant', content: [{ type: 'text', text: 'Legacy answer' }] },
                    uuid: 'legacy-assistant'
                })
            ].join('\n')
        )

        const session = await readSession(SESSION_ID)
        expect(session?.messages.map((message) => message.localId)).toEqual([
            `claude:${SESSION_ID}:legacy-user`,
            `claude:${SESSION_ID}:legacy-assistant`
        ])
    })

    it('does not miss cwd when the first transcript record exceeds the old pre-read window', async () => {
        const projectDir = join(tempDir, 'projects', '-tmp-claude-import-project')
        const longPrompt = `Start ${'x'.repeat(70 * 1024)}`
        writeFileSync(
            join(projectDir, `${SESSION_ID}.jsonl`),
            line({
                parentUuid: null,
                isSidechain: false,
                userType: 'external',
                cwd: CWD,
                sessionId: SESSION_ID,
                type: 'user',
                message: { role: 'user', content: longPrompt },
                uuid: 'long-user',
                timestamp: '2026-08-08T01:00:00.000Z'
            })
        )

        expect(await listLocalClaudeSessionSummaries()).toEqual([
            expect.objectContaining({
                id: SESSION_ID,
                cwd: CWD,
                messageCount: 1
            })
        ])
    })
})
