import { describe, expect, it } from 'vitest'
import { normalizeDecryptedMessage } from './normalize'
import type { DecryptedMessage } from '@/types/api'

function makeMessage(content: unknown): DecryptedMessage {
    return {
        id: 'msg-1',
        seq: 1,
        localId: null,
        content,
        createdAt: 1_742_372_800_000
    }
}

describe('normalizeDecryptedMessage', () => {
    it('drops unsupported Claude system output records', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'stop_hook_summary',
                    uuid: 'sys-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('drops Claude init system output records', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'init',
                    uuid: 'sys-init',
                    session_id: 'session-1'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('keeps known Claude system subtypes as normalized events', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'turn_duration',
                    uuid: 'sys-2',
                    durationMs: 1200
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'turn-duration',
                durationMs: 1200
            }
        })
    })

    it('normalizes away_summary (auto recap) system output into a recap event', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'away_summary',
                    uuid: 'sys-3',
                    content: 'Building the login flow, next: wire up the submit handler.'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            id: 'msg-1',
            role: 'event',
            isSidechain: false,
            content: {
                type: 'recap',
                text: 'Building the login flow, next: wire up the submit handler.'
            }
        })
    })

    it('skips away_summary with empty content instead of emitting a bare recap row', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'away_summary',
                    uuid: 'sys-4',
                    content: ''
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('skips away_summary with whitespace-only content instead of emitting a bare recap row', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'system',
                    subtype: 'away_summary',
                    uuid: 'sys-5',
                    content: '   '
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('keeps the stringify fallback for unknown non-system agent payloads', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    foo: 'bar'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            id: 'msg-1',
            role: 'agent',
            isSidechain: false
        })

        expect(normalized?.role).toBe('agent')
        if (!normalized || normalized.role !== 'agent') {
            throw new Error('Expected agent message')
        }
        const firstBlock = normalized.content[0]
        expect(firstBlock).toMatchObject({
            type: 'text',
        })
        if (firstBlock.type !== 'text') {
            throw new Error('Expected fallback text block')
        }
        expect(firstBlock.text).toContain('"foo": "bar"')
    })

    it('renders agy_message as an agent text block (not raw JSON)', () => {
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_message', content: 'PINGOK22' } }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const block = normalized.content[0]
        expect(block).toMatchObject({ type: 'text', text: 'PINGOK22' })
    })

    it('renders an "Inside the task-NNN log…" narration as a compact task-log chip (not a bubble)', () => {
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_message', content: 'Inside the task-266 log...' } }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        if (call.type !== 'tool-call') throw new Error('expected a tool-call chip, not a text bubble')
        expect(call.name).toBe('AgyTaskLog')
        // Task number carried via input so the chip title reads "task-266 log"
        // without duplicating into the subtitle (which falls back to description).
        expect(call.input).toEqual({ task: 'task-266' })
    })

    it('carries the per-turn model on agy_message for the metadata footer', () => {
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_message', content: 'hi', model: 'Gemini 3.5 Flash (Medium)' } }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        expect(normalized.model).toBe('Gemini 3.5 Flash (Medium)')
    })

    it('agy_message without a model leaves model null (no footer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_message', content: 'hi' } }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        expect(normalized.model).toBeNull()
    })

    it('skips empty agy_message instead of showing raw JSON', () => {
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_message', content: '   ' } }
        })
        expect(normalizeDecryptedMessage(message)).toBeNull()
    })

    it('marks AGY Read actions with non-input numbered-read provenance', () => {
        const normalized = normalizeDecryptedMessage(makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'VIEW_FILE',
                    toolName: 'view_file',
                    input: { AbsolutePath: '/tmp/list.txt' },
                    content: '1: first\n2: second'
                }
            }
        }))

        expect(Array.isArray(normalized?.content)).toBe(true)
        if (!Array.isArray(normalized?.content)) throw new Error('expected normalized tool content')
        expect(normalized.content[0]).toMatchObject({
            type: 'tool-call',
            name: 'Read',
            nativeKind: 'agy-numbered-read',
            input: { file_path: '/tmp/list.txt' }
        })
    })

    it('renders agy_tool_action as a humanized tool-call card (no raw blob)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'RUN_COMMAND',
                    content: 'Created At: 2026-06-10T15:02:32Z\nCompleted At: 2026-06-10T15:02:32Z\nThe command completed successfully.'
                }
            }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        const result = normalized.content[1]
        expect(call).toMatchObject({ type: 'tool-call', name: 'Run command' })
        // Paired tool-result (matching id) → card renders as COMPLETED, not Running.
        expect(result).toMatchObject({ type: 'tool-result', is_error: false })
        if (result.type !== 'tool-result') throw new Error('expected tool-result')
        expect(call.type === 'tool-call' && call.id).toBe((result as { tool_use_id: string }).tool_use_id)
        // Timestamp preamble stripped; substantive result kept.
        expect(String(result.content)).toContain('completed successfully')
        expect(String(result.content)).not.toContain('Created At')
    })

    it('renders a paired run_command invocation as a Bash card with the command as input', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'RUN_COMMAND',
                    toolName: 'run_command',
                    input: { CommandLine: 'ls -la /tmp', Cwd: '/home/lupin', toolSummary: 'List /tmp', WaitMsBeforeAsync: 5000 },
                    content: 'Output:\nfile1\nfile2'
                }
            }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        // run_command maps to the canonical Bash presentation used by the other flavors.
        expect(call.name).toBe('Bash')
        // The command surfaces as input (Bash card reads input.command); noise args dropped.
        expect(call.input).toMatchObject({ command: 'ls -la /tmp', cwd: '/home/lupin' })
        expect((call.input as Record<string, unknown>).WaitMsBeforeAsync).toBeUndefined()
        expect((call.input as Record<string, unknown>).toolSummary).toBeUndefined()
        // toolSummary becomes the card description (title slot).
        expect(call.description).toBe('List /tmp')
    })

    it('renders a paired view_file invocation as a Read card with the file path', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'VIEW_FILE',
                    toolName: 'view_file',
                    input: { AbsolutePath: '/home/lupin/app.ts', toolSummary: 'View app.ts' },
                    content: 'file contents'
                }
            }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        expect(call.name).toBe('Read')
        expect(call.input).toMatchObject({ file_path: '/home/lupin/app.ts' })
    })

    it('maps write_to_file to a Write card with the file path and content', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'CODE_ACTION',
                    toolName: 'write_to_file',
                    input: { TargetFile: '/tmp/x.py', CodeContent: 'print(1)', Overwrite: true, toolSummary: 'Write x.py' },
                    content: 'Created file'
                }
            }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        expect(call.name).toBe('Write')
        // Write view reads input.content under input.file_path.
        expect(call.input).toMatchObject({ file_path: '/tmp/x.py', content: 'print(1)' })
    })

    it('maps replace_file_content to an Edit card with an old→new diff', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'CODE_ACTION',
                    toolName: 'replace_file_content',
                    input: { TargetFile: '/tmp/x.py', TargetContent: 'a = 1', ReplacementContent: 'a = 2', toolSummary: 'Edit x.py' },
                    content: 'Changed'
                }
            }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        expect(call.name).toBe('Edit')
        // Edit view renders a diff from old_string → new_string.
        expect(call.input).toMatchObject({ file_path: '/tmp/x.py', old_string: 'a = 1', new_string: 'a = 2' })
    })

    it('maps grep_search to a Grep card with the pattern', () => {
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_tool_action', name: 'GREP_SEARCH', toolName: 'grep_search', input: { Query: 'TODO' }, content: 'match' } }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        expect(call.name).toBe('Grep')
        expect(call.input).toMatchObject({ pattern: 'TODO' })
    })

    it('falls back to the humanized action label for a genuinely unmapped agy tool but still surfaces its input', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'GENERIC',
                    toolName: 'list_permissions',
                    input: { Scope: 'workspace', toolSummary: 'List permissions' },
                    content: 'ok'
                }
            }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        // Unmapped tool keeps a humanized label…
        expect(call.name).toBe('List permissions')
        // …but its args still surface (passed through the generic normalizer).
        expect(call.input).toMatchObject({ Scope: 'workspace' })
        expect(call.description).toBe('List permissions')
    })

    it('renders agy SYSTEM_MESSAGE as a background-task card (framing stripped, error flagged)', () => {
        const raw = [
            'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.',
            '',
            '<SYSTEM_MESSAGE>',
            '[Message] timestamp=2026-07-08T06:04:00Z sender=uuid/task-228 priority=MESSAGE_PRIORITY_HIGH content=Task id "uuid/task-228" finished with result:',
            '',
            '\t\t\t\tThe command failed with exit code: 1',
            '\t\t\t\tOutput:',
            '\t\t\t\tjava is not a mise bin',
            '</SYSTEM_MESSAGE>',
        ].join('\n')
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_tool_action', name: 'SYSTEM_MESSAGE', content: raw, toolUseId: 'b:9' } }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        const result = normalized.content[1]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        if (result.type !== 'tool-result') throw new Error('expected tool-result')
        // Dedicated background-task presentation, not a mislabeled "System message".
        expect(call.name).toBe('AgyAsyncTask')
        expect(call.description).toBe('task-228 · failed (exit 1)')
        expect(call.input).toBeUndefined()
        // Framing stripped; substantive task output kept; error flagged.
        expect(String(result.content)).toContain('The command failed with exit code: 1')
        expect(String(result.content)).toContain('java is not a mise bin')
        expect(String(result.content)).not.toContain('not actually sent by the user')
        expect(String(result.content)).not.toContain('<SYSTEM_MESSAGE>')
        expect(result.is_error).toBe(true)
    })

    it('marks a successful agy SYSTEM_MESSAGE task as non-error', () => {
        const raw = '<SYSTEM_MESSAGE>\n[Message] sender=x/task-266 content=Task id "x/task-266" finished with result:\n\tThe command completed successfully.\n\tOutput: ok\n</SYSTEM_MESSAGE>'
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_tool_action', name: 'SYSTEM_MESSAGE', content: raw } }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        const result = normalized.content[1]
        if (call.type !== 'tool-call' || result.type !== 'tool-result') throw new Error('shape')
        expect(call.description).toBe('task-266 · completed')
        expect(result.is_error).toBe(false)
    })

    it('renders agy ERROR_MESSAGE as a dedicated error card (guidance stripped, error flagged)', () => {
        const raw = [
            'Created At: 2026-07-08T14:25:26+09:00',
            'Error invalid tool call: There was a problem parsing the tool call. ',
            'Error Message: model output error: invalid tool call error (invalid_args) failed to read file: read /Users/lupin/.claude/skills: is a directory ',
            'Guidance: You are trying to correct your previous tool call error, you must focus on fixing the failed tool call. Do not apologize. ',
            'Retries remaining: 4.',
        ].join('\n')
        const message = makeMessage({
            role: 'agent',
            content: { type: 'output', data: { type: 'agy_tool_action', name: 'ERROR_MESSAGE', content: raw, toolUseId: 'b:36' } }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        const result = normalized.content[1]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        if (result.type !== 'tool-result') throw new Error('expected tool-result')
        // Dedicated error presentation, not a mislabeled "Error message" tool card.
        expect(call.name).toBe('AgyError')
        expect(call.description).toBe('Invalid tool call')
        expect(call.input).toBeUndefined()
        // Core error kept; bookkeeping + agent-directed guidance stripped; error flagged.
        expect(String(result.content)).toContain('is a directory')
        expect(String(result.content)).not.toContain('Created At:')
        expect(String(result.content)).not.toContain('Guidance:')
        expect(String(result.content)).not.toContain('Retries remaining')
        expect(result.is_error).toBe(true)
    })

    it('keeps input undefined for a legacy agy_tool_action with no paired invocation', () => {
        // Older sessions (before invocation pairing) send only name + content.
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: { type: 'agy_tool_action', name: 'RUN_COMMAND', content: 'result' }
            }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        if (call.type !== 'tool-call') throw new Error('expected tool-call')
        expect(call.name).toBe('Run command')
        expect(call.input).toBeUndefined()
    })

    it('keys agy_tool_action by toolUseId so it merges with the permission card', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'agy_tool_action',
                    name: 'GENERIC',
                    content: 'You have 0 active subagents',
                    toolUseId: 'brain-uuid:9'
                }
            }
        })
        const normalized = normalizeDecryptedMessage(message)
        if (!normalized || normalized.role !== 'agent') throw new Error('Expected agent message')
        const call = normalized.content[0]
        const result = normalized.content[1]
        // The tool-call/result are keyed by the conversationId:stepIdx id (same as
        // the PreToolUse permission request), not the message id — so the reducer
        // merges them into the existing approval card instead of a duplicate.
        expect(call.type === 'tool-call' && call.id).toBe('brain-uuid:9')
        expect(result.type === 'tool-result' && (result as { tool_use_id: string }).tool_use_id).toBe('brain-uuid:9')
    })

    it('normalizes <task-notification> user output as sidechain (event extracted by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u-notif',
                    message: { content: '<task-notification> <summary>Background command stopped</summary> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        // Normalizer emits as sidechain (preserving uuid for sentinel detection);
        // the reducer extracts the summary as an event.
        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role === 'agent') {
            expect(normalized.content[0]).toMatchObject({
                type: 'sidechain',
                prompt: expect.stringContaining('<task-notification>')
            })
        }
    })

    it('treats <task-notification> without summary as sidechain (dropped by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u3',
                    message: { content: '<task-notification> <status>killed</status> </task-notification>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
    })

    it('keeps Codex/OpenCode reasoning stream ids for snapshot merging', () => {
        const normalized = normalizeDecryptedMessage(makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'reasoning',
                    id: 'reasoning-stream-1',
                    message: 'thinking'
                }
            }
        }))

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'reasoning',
                text: 'thinking',
                streamId: 'reasoning-stream-1'
            }]
        })
    })

    it('normalizes agent error payloads as error events', () => {
        const normalized = normalizeDecryptedMessage(makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'error',
                    message: 'Cursor Agent failed: authentication required'
                }
            }
        }))

        expect(normalized).toMatchObject({
            role: 'event',
            content: {
                type: 'error',
                message: 'Cursor Agent failed: authentication required'
            }
        })
    })

    it('treats non-sidechain string user output as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    isSidechain: false,
                    uuid: 'u1',
                    message: { content: 'This is a subagent prompt' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'This is a subagent prompt'
        })
    })

    it('treats <system-reminder> user output as sidechain (dropped by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u2',
                    message: { content: '<system-reminder>Some internal reminder</system-reminder>' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
    })

    it('treats sidechain user output with array content as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u3',
                    isSidechain: true,
                    message: { content: [{ type: 'text', text: 'This is an agent prompt in array form' }] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'This is an agent prompt in array form'
        })
    })

    it('propagates parentToolUseId from a sidechain user output onto the normalized message (subagent trace grouping fix)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u-orphan-child',
                    isSidechain: true,
                    parentToolUseId: 'toolu_broken_agent',
                    message: { content: 'orphaned subagent turn with no prompt-root' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
            parentToolUseId: 'toolu_broken_agent',
        })
    })

    it('propagates parentToolUseId from a sidechain assistant output onto the normalized message (subagent trace grouping fix)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'u-orphan-child-2',
                    isSidechain: true,
                    parentToolUseId: 'toolu_broken_agent',
                    message: {
                        role: 'assistant',
                        content: [{ type: 'text', text: 'subagent thinking' }]
                    }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
            parentToolUseId: 'toolu_broken_agent',
        })
    })

    it('keeps "No response requested." text in normalized output (filtered later by reducer)', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-1',
                    message: { role: 'assistant', content: 'No response requested.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        // Normalizer preserves the text (uuid/parentUUID needed by tracer);
        // the reducer is responsible for suppressing it during rendering.
        expect(normalized).not.toBeNull()
        expect(normalized?.role).toBe('agent')
        if (normalized?.role === 'agent') {
            expect(normalized.content).toHaveLength(1)
            expect(normalized.content[0]).toMatchObject({ type: 'text', text: 'No response requested.' })
        }
    })

    it('keeps assistant messages with real content', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-2',
                    message: { role: 'assistant', content: 'Here is the answer.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        expect(normalized?.role).toBe('agent')
    })

    it('propagates parentUuid from assistant output data to text block parentUUID', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-3',
                    parentUuid: 'parent-injected-uuid',
                    message: { role: 'assistant', content: 'No response requested.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content).toHaveLength(1)
        expect(normalized.content[0]).toMatchObject({
            type: 'text',
            text: 'No response requested.',
            parentUUID: 'parent-injected-uuid'
        })
    })

    it('sets parentUUID to null when parentUuid is absent in assistant output', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'a-4',
                    // No parentUuid field
                    message: { role: 'assistant', content: 'Hello.' }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)
        expect(normalized).not.toBeNull()
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'text',
            parentUUID: null
        })
    })

    it('normalizes non-sidechain text-only array-content user output as user message', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u5',
                    isSidechain: false,
                    message: { content: [{ type: 'text', text: 'Regular user message' }] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'user',
            isSidechain: false,
            content: { type: 'text', text: 'Regular user message' }
        })
    })

    it('treats sidechain user output with mixed tool_result + text array as sidechain', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'u6',
                    isSidechain: true,
                    message: { content: [
                        { type: 'tool_result', tool_use_id: 'tc-1', content: 'result' },
                        { type: 'text', text: 'Some subagent text' }
                    ] }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            isSidechain: true,
        })
        if (normalized?.role !== 'agent') throw new Error('Expected agent')
        expect(normalized.content[0]).toMatchObject({
            type: 'sidechain',
            prompt: 'Some subagent text'
        })
    })

    it('preserves Codex tool-call-result errors for timeline state', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'tool-call-result',
                    callId: 'call-1',
                    output: 'tool failed',
                    is_error: true,
                    id: 'result-1'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'tool-result',
                    tool_use_id: 'call-1',
                    content: 'tool failed',
                    is_error: true
                }
            ]
        })
    })

    it('normalizes Codex review JSON messages as structured review content', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: JSON.stringify({
                        findings: [{
                            title: '[P2] Remove retained sessions when sockets disconnect',
                            body: 'Retained sockets survive disconnects.',
                            confidence_score: 0.82,
                            priority: 2,
                            code_location: {
                                absolute_file_path: '/data/dz/wapair-ts/src/pairing/manager.ts',
                                line_range: { start: 1614, end: 1619 }
                            }
                        }],
                        overall_correctness: 'patch is incorrect',
                        overall_explanation: 'The message-sending feature retains long-lived sockets but does not fully manage their lifecycle.',
                        overall_confidence_score: 0.8
                    })
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'codex-review',
                review: {
                    overallCorrectness: 'patch is incorrect',
                    overallExplanation: 'The message-sending feature retains long-lived sockets but does not fully manage their lifecycle.',
                    overallConfidenceScore: 0.8,
                    findings: [{
                        title: '[P2] Remove retained sessions when sockets disconnect',
                        body: 'Retained sockets survive disconnects.',
                        priority: 2,
                        confidenceScore: 0.82,
                        filePath: '/data/dz/wapair-ts/src/pairing/manager.ts',
                        lineStart: 1614,
                        lineEnd: 1619
                    }]
                }
            }]
        })
    })

    it('keeps non-review Codex JSON messages as text', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: JSON.stringify({ status: 'ok', message: 'plain JSON' })
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: '{"status":"ok","message":"plain JSON"}'
            }]
        })
    })

    it('keeps malformed Codex review-looking messages as text', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'message',
                    message: '{"findings": ['
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [{
                type: 'text',
                text: '{"findings": ['
            }]
        })
    })

    it('normalizes ACP plan messages as completed update_plan snapshots', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'plan',
                    entries: [
                        { content: 'Inspect event stream', status: 'completed' },
                        { content: 'Render plan card', status: 'in_progress' }
                    ],
                    id: 'cursor-plan-1'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'tool-call',
                    id: 'cursor-plan-state',
                    name: 'update_plan',
                    input: {
                        plan: [
                            { step: 'Inspect event stream', status: 'completed' },
                            { step: 'Render plan card', status: 'in_progress' }
                        ],
                        source: 'cursor'
                    }
                },
                {
                    type: 'tool-result',
                    tool_use_id: 'cursor-plan-state',
                    content: {
                        plan: [
                            { step: 'Inspect event stream', status: 'completed' },
                            { step: 'Render plan card', status: 'in_progress' }
                        ],
                        source: 'cursor'
                    }
                }
            ]
        })
    })

    it('normalizes Codex plan updates as completed update_plan snapshots', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'plan_update',
                    plan: [
                        { step: 'Inspect event stream', status: 'completed' },
                        { step: 'Render plan card', status: 'in_progress' }
                    ],
                    id: 'plan-update-1'
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'agent',
            content: [
                {
                    type: 'tool-call',
                    id: 'codex-plan-state',
                    name: 'update_plan',
                    input: {
                        plan: [
                            { step: 'Inspect event stream', status: 'completed' },
                            { step: 'Render plan card', status: 'in_progress' }
                        ],
                        source: 'codex'
                    }
                },
                {
                    type: 'tool-result',
                    tool_use_id: 'codex-plan-state',
                    content: {
                        plan: [
                            { step: 'Inspect event stream', status: 'completed' },
                            { step: 'Render plan card', status: 'in_progress' }
                        ],
                        source: 'codex',
                        status: 'updated'
                    }
                }
            ]
        })
    })

    it('normalizes Codex token_count as usage data for context display', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'token_count',
                    info: {
                        total: {
                            inputTokens: 82_503,
                            cachedInputTokens: 71_808,
                            outputTokens: 166
                        },
                        modelContextWindow: 258_400
                    }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'event',
            content: {
                type: 'token-count'
            },
            usage: {
                input_tokens: 82503,
                output_tokens: 166
            }
        })
    })

    it('normalizes Codex scoped snake_case usage fields', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'token_count',
                    thread_id: 'child-thread',
                    scope: { role: 'child' },
                    info: {
                        last_token_usage: {
                            input_tokens: 321,
                            output_tokens: 12,
                            cached_input_tokens: 100
                        },
                        model_context_window: 258_400
                    }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'event',
            usage: {
                input_tokens: 321,
                output_tokens: 12,
                cache_read_input_tokens: 100,
                context_tokens: 321,
                context_window: 258400,
                thread_id: 'child-thread',
                scope_role: 'child'
            }
        })
    })

    it('normalizes token_count payloads with explicit contextTokens', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'token_count',
                    info: {
                        total: {
                            inputTokens: 8_119,
                            outputTokens: 2,
                            cachedInputTokens: 5_760,
                            thoughtTokens: 11,
                            totalTokens: 13_892
                        },
                        contextTokens: 13_879,
                        modelContextWindow: 65_536
                    }
                }
            }
        })

        const normalized = normalizeDecryptedMessage(message)

        expect(normalized).toMatchObject({
            role: 'event',
            usage: {
                input_tokens: 8119,
                output_tokens: 2,
                cache_read_input_tokens: 5760,
                context_tokens: 13879,
                context_window: 65536
            }
        })
    })

    it('normalizes Codex context_compacted as a compact event', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'context_compacted',
                    trigger: 'auto',
                    pre_tokens: 1234
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            role: 'event',
            content: {
                type: 'compact',
                trigger: 'auto',
                preTokens: 1234
            }
        })
    })

    it('normalizes Codex agent-run events for timeline aggregation', () => {
        const message = makeMessage({
            role: 'agent',
            content: {
                type: 'codex',
                data: {
                    type: 'agent-run-start',
                    cardId: 'spawn-1',
                    input: { message: 'inspect files' },
                    status: 'starting'
                }
            }
        })

        expect(normalizeDecryptedMessage(message)).toMatchObject({
            role: 'event',
            content: {
                type: 'agent-run-start',
                cardId: 'spawn-1',
                input: { message: 'inspect files' },
                status: 'starting'
            }
        })
    })

})
