import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { notification: vi.fn(), selection: vi.fn() } })
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { PermissionFooter } from './PermissionFooter'

const DECISION_LABELS = ['tool.yes', 'tool.yesForSession', 'tool.abortLabel']
const PLAIN_LABELS = ['tool.allow', 'tool.allowForSession', 'tool.deny']

function makeTool(name = 'Bash', input: unknown = { command: 'ls -la' }): ChatToolCall {
    return {
        id: 'tool-1',
        name,
        state: 'pending',
        input,
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        permission: { id: 'permission-1', status: 'pending' }
    } as unknown as ChatToolCall
}

function renderFooter(options: {
    flavor?: string | null
    metadata?: SessionMetadataSummary | null
    name?: string
    input?: unknown
}) {
    const approvePermission = vi.fn().mockResolvedValue(undefined)
    const denyPermission = vi.fn().mockResolvedValue(undefined)
    const metadata = options.metadata === undefined
        ? ({ path: '/tmp/project', host: 'localhost', flavor: options.flavor } as SessionMetadataSummary)
        : options.metadata
    const rendered = render(
        <PermissionFooter
            api={{ approvePermission, denyPermission } as unknown as ApiClient}
            sessionId="session-1"
            metadata={metadata}
            tool={makeTool(options.name, options.input)}
            disabled={false}
            onDone={vi.fn()}
        />
    )
    return { approvePermission, denyPermission, unmount: rendered.unmount }
}

function buttonLabels(): string[] {
    return screen.getAllByRole('button').map((button) => button.textContent)
}

describe('PermissionFooter', () => {
    describe('buttons by session flavor', () => {
        it.each(['codex', 'copilot', 'cursor', 'gemini', 'grok', 'kimi', 'opencode'])(
            '%s offers yes / yes-for-session / abort',
            (flavor) => {
                renderFooter({ flavor })
                expect(buttonLabels()).toEqual(DECISION_LABELS)
            }
        )

        it.each(['claude', 'agy', 'dsh', 'pi', 'unknown-flavor'])(
            '%s offers allow / allow-for-session / deny on a Bash request',
            (flavor) => {
                renderFooter({ flavor })
                expect(buttonLabels()).toEqual(PLAIN_LABELS)
            }
        )

        it('offers allow / allow-for-session / deny when session metadata is missing', () => {
            renderFooter({ metadata: null })
            expect(buttonLabels()).toEqual(PLAIN_LABELS)
        })

        it('offers allow-all-edits to claude on an edit tool, in place of allow-for-session', () => {
            renderFooter({ flavor: 'claude', name: 'Edit', input: { file_path: 'a.ts' } })
            expect(buttonLabels()).toEqual(['tool.allow', 'tool.allowAll', 'tool.deny'])
        })

        it.each(['codex', 'agy', 'pi'])('does not offer allow-all-edits to %s on an edit tool', (flavor) => {
            renderFooter({ flavor, name: 'Edit', input: { file_path: 'a.ts' } })
            expect(buttonLabels()).not.toContain('tool.allowAll')
        })
    })

    describe('buttons by tool name prefix', () => {
        const prefixedTools = ['CodexSearch', 'GeminiAsk', 'OpenCodeRead', 'CopilotChat', 'CursorList']
        const flavors = ['claude', 'agy', 'dsh', 'pi', 'unknown-flavor', null]

        it.each(flavors.flatMap((flavor) => prefixedTools.map((tool) => [flavor, tool] as const)))(
            'a %s session offers decision buttons for the %s tool',
            (flavor, tool) => {
                renderFooter({ metadata: flavor === null ? null : undefined, flavor: flavor ?? undefined, name: tool })
                expect(buttonLabels()).toEqual(DECISION_LABELS)
            }
        )

        it.each([
            ['tool.yes', 'approve', { decision: 'approved' }],
            ['tool.yesForSession', 'approve', { decision: 'approved_for_session' }],
            ['tool.abortLabel', 'deny', { decision: 'abort' }]
        ] as const)('a claude session answering a prefixed tool with %s sends %j via %s', (label, call, body) => {
            const { approvePermission, denyPermission } = renderFooter({ flavor: 'claude', name: 'CodexSearch' })
            fireEvent.click(screen.getByRole('button', { name: label }))
            const sent = call === 'approve' ? approvePermission : denyPermission
            const other = call === 'approve' ? denyPermission : approvePermission
            expect(sent).toHaveBeenCalledWith('session-1', 'permission-1', body)
            expect(other).not.toHaveBeenCalled()
        })
    })

    describe('replies', () => {
        it.each([
            ['tool.yes', { decision: 'approved' }],
            ['tool.yesForSession', { decision: 'approved_for_session' }]
        ])('a decision-style %s sends %j', (label, body) => {
            const { approvePermission } = renderFooter({ flavor: 'codex' })
            fireEvent.click(screen.getByRole('button', { name: label }))
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', body)
        })

        it('a decision-style abort denies with {decision: abort}', () => {
            const { denyPermission } = renderFooter({ flavor: 'codex' })
            fireEvent.click(screen.getByRole('button', { name: 'tool.abortLabel' }))
            expect(denyPermission).toHaveBeenCalledWith('session-1', 'permission-1', { decision: 'abort' })
        })

        it('claude allow sends a plain approval', () => {
            const { approvePermission } = renderFooter({ flavor: 'claude' })
            fireEvent.click(screen.getByRole('button', { name: 'tool.allow' }))
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1')
        })

        it('claude allow-for-session sends the Bash command as an allowTools entry', () => {
            const { approvePermission } = renderFooter({ flavor: 'claude' })
            fireEvent.click(screen.getByRole('button', { name: 'tool.allowForSession' }))
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', { allowTools: ['Bash(ls -la)'] })
        })

        it('claude allow-all-edits sends acceptEdits', () => {
            const { approvePermission } = renderFooter({ flavor: 'claude', name: 'Edit', input: { file_path: 'a.ts' } })
            fireEvent.click(screen.getByRole('button', { name: 'tool.allowAll' }))
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', 'acceptEdits')
        })

        it('a generic-style allow-for-session sends the session decision', () => {
            const { approvePermission } = renderFooter({ flavor: 'agy' })
            fireEvent.click(screen.getByRole('button', { name: 'tool.allowForSession' }))
            expect(approvePermission).toHaveBeenCalledWith('session-1', 'permission-1', { decision: 'approved_for_session' })
        })
    })
})
