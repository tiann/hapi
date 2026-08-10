import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_IMPORT_MIN_PAGE_BYTES } from '@hapi/protocol/apiTypes'
import {
    listLocalClaudeSessionMessagesPageById,
    listLocalClaudeSessionSummaries,
    listLocalClaudeSessionsWithMessagesByIds
} from './claudeSessions'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const CWD = '/tmp/claude-import-project'

function line(value: Record<string, unknown>): string {
    return JSON.stringify(value)
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

    it('lists main transcripts, converts visible history, and ignores subagent files', () => {
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

        expect(listLocalClaudeSessionSummaries()).toEqual([
            expect.objectContaining({
                id: SESSION_ID,
                title: 'Renamed imported work',
                lastUserMessage: 'First prompt',
                cwd: CWD,
                model: 'claude-sonnet-4-5',
                messageCount: 2
            })
        ])

        const full = listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID]))
        expect(full).toHaveLength(1)
        expect(full[0]?.messages).toEqual([
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

    it('returns only requested session transcripts', () => {
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

        const sessions = listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID]))
        expect(sessions.map((session) => session.id)).toEqual([SESSION_ID])
    })

    it('pages one transcript below a byte budget without losing message order', () => {
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
                message: { role: 'assistant', content: [{ type: 'text', text: `${index}:${'x'.repeat(40 * 1024)}` }] },
                uuid
            })
            parentUuid = uuid
        }
        writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), records.map(line).join('\n'))

        const localIds: string[] = []
        let cursor = 0
        let pageCount = 0
        while (true) {
            const page = listLocalClaudeSessionMessagesPageById(SESSION_ID, cursor, CLAUDE_IMPORT_MIN_PAGE_BYTES)
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

    it('replaces a single aggregate-oversized agent record before transport', () => {
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

        const page = listLocalClaudeSessionMessagesPageById(SESSION_ID, 0, CLAUDE_IMPORT_MIN_PAGE_BYTES)

        expect(page?.nextCursor).toBeNull()
        expect(JSON.stringify(page?.messages[0]?.content)).toContain('oversized imported Claude message omitted')
        expect(Buffer.byteLength(JSON.stringify({ success: true, mode: 'messages', page }), 'utf8'))
            .toBeLessThanOrEqual(CLAUDE_IMPORT_MIN_PAGE_BYTES)
    })

    it('imports only the active branch after a Claude rewind', () => {
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
            }
        ]
        writeFileSync(join(projectDir, `${SESSION_ID}.jsonl`), transcript.map(line).join('\n'))

        const [session] = listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID]))
        expect(session?.messages.map((message) => message.localId)).toEqual([
            `claude:${SESSION_ID}:user-1`,
            `claude:${SESSION_ID}:assistant-1`,
            `claude:${SESSION_ID}:sidechain-active`,
            `claude:${SESSION_ID}:user-new`,
            `claude:${SESSION_ID}:assistant-new`
        ])
        expect(session).toMatchObject({
            lastUserMessage: 'Replacement prompt',
            messageCount: 5
        })
    })

    it('keeps linear history when legacy records have no parent links', () => {
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

        const [session] = listLocalClaudeSessionsWithMessagesByIds(new Set([SESSION_ID]))
        expect(session?.messages.map((message) => message.localId)).toEqual([
            `claude:${SESSION_ID}:legacy-user`,
            `claude:${SESSION_ID}:legacy-assistant`
        ])
    })

    it('does not miss cwd when the first transcript record exceeds the old pre-read window', () => {
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

        expect(listLocalClaudeSessionSummaries()).toEqual([
            expect.objectContaining({
                id: SESSION_ID,
                cwd: CWD,
                messageCount: 1
            })
        ])
    })
})
