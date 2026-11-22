import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// Mirror opencodeSessions.test.ts: production lazy-imports bun:sqlite under
// Bun, so these tests execute agySessions inside a real `bun` subprocess
// against a temporary SQLite database + brain transcript tree, plus verify
// the filesystem fallback when no database exists.

const RUNNER = /* ts */ `
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import {
    getAgyBrainDir,
    getAgyDbPath,
    listLocalAgySessionSummaries,
    listLocalAgySessionsWithMessagesByIds
} from './agySessions'
import { AGY_WAKEUP_CONTINUE_PROMPT } from '../../agy/agyReactiveWakeup'

function createDb(root: string) {
    const db = new Database(join(root, 'conversation_summaries.db'))
    db.exec(\`
        CREATE TABLE conversation_summaries (
            conversation_id TEXT PRIMARY KEY,
            title TEXT,
            preview TEXT,
            step_count INTEGER,
            last_modified_time DATETIME,
            workspace_uris TEXT,
            status TEXT,
            source TEXT,
            parent_conversation_id TEXT,
            nesting_depth INTEGER
        );
    \`)
    return db
}

function writeTranscript(root: string, id: string, steps: unknown[], fullSteps?: unknown[]) {
    const logsDir = join(root, 'brain', id, '.system_generated', 'logs')
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(
        join(logsDir, 'transcript.jsonl'),
        steps.map((s) => JSON.stringify(s)).join('\\n') + '\\n'
    )
    if (fullSteps) {
        writeFileSync(
            join(logsDir, 'transcript_full.jsonl'),
            fullSteps.map((s) => JSON.stringify(s)).join('\\n') + '\\n'
        )
    }
}

const results: Record<string, unknown> = {}

// 1. Path overrides + DB-backed summary listing (filters subagents & missing transcripts)
{
    const root = mkdtempSync(join(tmpdir(), 'hapi-agy-sessions-db-'))
    try {
        const db = createDb(root)
        const insert = db.query(\`
            INSERT INTO conversation_summaries (
                conversation_id, title, preview, step_count, last_modified_time,
                workspace_uris, status, source, parent_conversation_id, nesting_depth
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        \`)

        insert.run(
            'conv-main',
            'Fix background task',
            'Second prompt line\\nwith detail',
            5,
            '2026-11-22 09:19:08.9810408+00:00',
            JSON.stringify(['file:///tmp/my%20repo']),
            'CASCADE_RUN_STATUS_IDLE',
            '',
            '',
            0
        )
        insert.run(
            'conv-untitled',
            '',
            'ping first message',
            2,
            '2026-11-21 14:33:22.2333537+00:00',
            JSON.stringify(['file:///tmp/other']),
            'CASCADE_RUN_STATUS_IDLE',
            '',
            '',
            0
        )
        insert.run(
            'conv-subagent',
            'Subagent',
            'inner task',
            4,
            '2026-11-22 10:00:00.000000+00:00',
            JSON.stringify(['file:///tmp/my%20repo']),
            'CASCADE_RUN_STATUS_IDLE',
            '',
            'conv-main',
            1
        )
        insert.run(
            'conv-missing-file',
            'Ghost',
            'gone',
            3,
            '2026-11-22 11:00:00.000000+00:00',
            JSON.stringify(['file:///tmp/my%20repo']),
            'CASCADE_RUN_STATUS_IDLE',
            '',
            '',
            0
        )
        db.close()

        writeTranscript(root, 'conv-main', [
            {
                step_index: 0,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-11-22T09:10:00Z',
                content: '<USER_REQUEST>\\nRun tests cleanly\\n</USER_REQUEST>\\n<ADDITIONAL_METADATA>\\ntime\\n</ADDITIONAL_METADATA>'
            },
            {
                step_index: 1,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-22T09:10:01Z',
                thinking: 'Planning check',
                content: 'Checking now',
                tool_calls: [{
                    name: 'run_command',
                    args: { CommandLine: JSON.stringify('echo hi'), Cwd: JSON.stringify('/tmp/my repo') }
                }]
            },
            {
                step_index: 2,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: '2026-11-22T09:10:02Z',
                content: 'Command still running in background. Task id "conv-main/task-1"',
                truncated_fields: ['content']
            },
            {
                step_index: 3,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-11-22T09:10:03Z',
                content: '<USER_REQUEST>\\n' + AGY_WAKEUP_CONTINUE_PROMPT + '\\n</USER_REQUEST>'
            },
            {
                step_index: 4,
                source: 'SYSTEM',
                type: 'SYSTEM_MESSAGE',
                status: 'DONE',
                created_at: '2026-11-22T09:10:04Z',
                content: '<SYSTEM_MESSAGE>Task id "conv-main/task-1" finished with result:\\nCommand exited with code 0.\\n\\nCommand output:\\nhi\\n</SYSTEM_MESSAGE>'
            }
        ], [
            {
                step_index: 2,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'RUNNING',
                created_at: '2026-11-22T09:10:02Z',
                content: 'Created At: 2026-11-22T09:10:02Z\\nCommand running in background.\\nTool is running as a background task with task id: conv-main/task-1'
            }
        ])

        writeTranscript(root, 'conv-untitled', [
            {
                step_index: 0,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-11-21T14:33:18Z',
                content: '<USER_REQUEST>\\nping first message\\n</USER_REQUEST>'
            },
            {
                step_index: 1,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-21T14:33:19Z',
                content: 'pong'
            }
        ])

        writeTranscript(root, 'conv-subagent', [
            {
                step_index: 0,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-11-22T10:00:00Z',
                content: '<USER_REQUEST>\\nsubagent prompt\\n</USER_REQUEST>'
            }
        ])

        const summaries = await listLocalAgySessionSummaries({ appDataDir: root })
        const firstRead = await listLocalAgySessionsWithMessagesByIds(new Set(['conv-main']), { appDataDir: root })
        const secondRead = await listLocalAgySessionsWithMessagesByIds(new Set(['conv-main']), { appDataDir: root })

        results.db = {
            dbPath: getAgyDbPath(root),
            brainDir: getAgyBrainDir(root),
            summaries,
            firstRead,
            deterministicEqual: JSON.stringify(firstRead) === JSON.stringify(secondRead)
        }
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

// 2. Fallback when DB does not exist (reads transcript.jsonl tree)
{
    const root = mkdtempSync(join(tmpdir(), 'hapi-agy-sessions-fallback-'))
    try {
        writeTranscript(root, 'conv-fallback', [
            {
                step_index: 0,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-11-22T01:00:00Z',
                content: '<USER_REQUEST>\\nFallback question\\n</USER_REQUEST>'
            },
            {
                step_index: 1,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-22T01:00:02Z',
                content: 'Fallback answer'
            }
        ])
        results.fallback = {
            summaries: await listLocalAgySessionSummaries({ appDataDir: root }),
            withMessages: await listLocalAgySessionsWithMessagesByIds(new Set(['conv-fallback']), { appDataDir: root, fallbackCwd: '/tmp/selected-project' })
        }

        // 3. Append-only stability when action steps arrive lazily after a multi-call planner step
        writeTranscript(root, 'conv-late-action', [
            {
                step_index: 0,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-11-22T02:00:00Z',
                content: '<USER_REQUEST>\\nRead two files\\n</USER_REQUEST>'
            },
            {
                step_index: 1,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-22T02:00:01Z',
                tool_calls: [
                    { name: 'read_file', args: { Path: JSON.stringify('/tmp/a.txt') } },
                    { name: 'read_file', args: { Path: JSON.stringify('/tmp/b.txt') } }
                ]
            }
        ])
        const beforeActions = (await listLocalAgySessionsWithMessagesByIds(new Set(['conv-late-action']), { appDataDir: root, fallbackCwd: '/tmp/selected-project' }))[0]!

        writeTranscript(root, 'conv-late-action', [
            {
                step_index: 0,
                source: 'USER_EXPLICIT',
                type: 'USER_INPUT',
                status: 'DONE',
                created_at: '2026-11-22T02:00:00Z',
                content: '<USER_REQUEST>\\nRead two files\\n</USER_REQUEST>'
            },
            {
                step_index: 1,
                source: 'MODEL',
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                created_at: '2026-11-22T02:00:01Z',
                tool_calls: [
                    { name: 'read_file', args: { Path: JSON.stringify('/tmp/a.txt') } },
                    { name: 'read_file', args: { Path: JSON.stringify('/tmp/b.txt') } }
                ]
            },
            {
                step_index: 2,
                source: 'MODEL',
                type: 'GENERIC',
                status: 'ERROR',
                created_at: '2026-11-22T02:00:02Z',
                content: 'ENOENT: missing a.txt'
            }
        ])
        const afterFirstAction = (await listLocalAgySessionsWithMessagesByIds(new Set(['conv-late-action']), { appDataDir: root, fallbackCwd: '/tmp/selected-project' }))[0]!
        results.lateAction = { beforeActions, afterFirstAction }
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
}

console.log(JSON.stringify(results))
`

function runBunSuite() {
    const res = spawnSync('bun', ['--eval', RUNNER], {
        cwd: join(__dirname),
        encoding: 'utf8'
    })
    if (res.status !== 0) {
        throw new Error(`bun runner failed (exit ${res.status}):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`)
    }
    return JSON.parse(res.stdout.trim()) as {
        db: {
            dbPath: string
            brainDir: string
            summaries: Array<{ id: string; title: string; cwd?: string | null; modifiedAt: number }>
            firstRead: Array<{
                id: string
                title: string
                cwd?: string | null
                messageCount?: number
                messages: Array<{ localId: string; anchor: string; content: { role: string; content: { type: string; data?: Record<string, unknown>; text?: string } } }>
            }>
            deterministicEqual: boolean
        }
        fallback: {
            summaries: Array<{ id: string; title: string; messageCount?: number }>
            withMessages: Array<{ id: string; cwd?: string | null; messages: Array<{ localId: string; content: Record<string, unknown> }> }>
        }
        lateAction: {
            beforeActions: { messages: Array<{ localId: string; anchor: string; content: Record<string, unknown> }> }
            afterFirstAction: { messages: Array<{ localId: string; anchor: string; content: Record<string, unknown> }> }
        }
    }
}

describe('agySessions', () => {
    it('lists DB summaries, skips subagents and missing transcripts, converts steps deterministically, and falls back without DB', () => {
        const output = runBunSuite()

        expect(output.db.summaries.map((s) => s.id)).toEqual(['conv-main', 'conv-untitled'])
        expect(output.db.summaries[0]?.title).toBe('Fix background task')
        expect(output.db.summaries[0]?.cwd).toMatch(/[\\/]tmp[\\/]my repo$/)
        expect(output.db.summaries[1]?.title).toBe('ping first message')

        const session = output.db.firstRead[0]!
        expect(session.id).toBe('conv-main')
        expect(session.messageCount).toBe(session.messages.length)
        expect(output.db.deterministicEqual).toBe(true)

        // Internal wakeup reattach prompt must be excluded.
        const userTexts = session.messages
            .filter((m) => m.content.role === 'user')
            .map((m) => m.content.content.text)
        expect(userTexts).toEqual(['Run tests cleanly'])

        // Step 1 produces planner reasoning/text/call IDs, step 2 owns its placeholder tool result,
        // and step 4 owns the completed background tool result with matching callId.
        const payloads = session.messages
            .filter((m) => m.content.role === 'agent')
            .map((m) => ({ localId: m.localId, data: m.content.content.data! }))

        expect(payloads[0]).toMatchObject({
            localId: 'agy:conv-main:step:1:reasoning',
            data: { type: 'reasoning', message: 'Planning check', id: 'agy:conv-main:step:1:reasoning' }
        })
        expect(payloads[1]).toMatchObject({
            localId: 'agy:conv-main:step:1:text',
            data: { type: 'message', message: 'Checking now' }
        })
        expect(payloads[2]).toMatchObject({
            localId: 'agy:conv-main:step:1:call:0',
            data: { type: 'tool-call', name: 'Bash', callId: 'agy-wakeup-conv-main-1-0', input: { command: 'echo hi', cwd: '/tmp/my repo' } }
        })
        expect(payloads[3]).toMatchObject({
            localId: 'agy:conv-main:step:2:0',
            data: { type: 'tool-call-result', callId: 'agy-wakeup-conv-main-1-0' }
        })
        expect(payloads[4]).toMatchObject({
            localId: 'agy:conv-main:step:4:0',
            data: { type: 'tool-call-result', callId: 'agy-wakeup-conv-main-1-0', output: { stdout: 'hi', exit_code: 0 }, is_error: false }
        })

        expect(output.fallback.summaries).toHaveLength(1)
        expect(output.fallback.summaries[0]).toMatchObject({
            id: 'conv-fallback',
            title: 'Fallback question',
            messageCount: 2
        })
        expect(output.fallback.withMessages[0]?.cwd).toBe('/tmp/selected-project')
        expect(output.fallback.withMessages[0]?.messages).toHaveLength(2)

        const { beforeActions, afterFirstAction } = output.lateAction
        expect(beforeActions.messages).toHaveLength(3)
        expect(afterFirstAction.messages).toHaveLength(4)
        expect(afterFirstAction.messages.slice(0, 3)).toEqual(beforeActions.messages)
        expect(afterFirstAction.messages[3]).toMatchObject({
            localId: 'agy:conv-late-action:step:2:0',
            anchor: 'step:2:0',
            content: {
                role: 'agent',
                content: {
                    type: 'codex',
                    data: {
                        type: 'tool-call-result',
                        callId: 'agy-wakeup-conv-late-action-1-0',
                        output: 'ENOENT: missing a.txt',
                        is_error: true
                    }
                }
            }
        })
    })
})
