import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listLocalClaudeSessionSummaries, listLocalClaudeSessionsWithMessagesByIds } from './claudeSessions'

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
