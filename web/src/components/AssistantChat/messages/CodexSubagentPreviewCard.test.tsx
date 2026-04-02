import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import { CodexSubagentPreviewCard } from '@/components/AssistantChat/messages/CodexSubagentPreviewCard'
import { getToolChildRenderMode } from '@/components/AssistantChat/messages/ToolMessage'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { I18nProvider } from '@/lib/i18n-context'

function makeSpawnBlock(): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'spawn-block-1',
        localId: null,
        createdAt: 1,
        tool: {
            id: 'spawn-1',
            name: 'CodexSpawnAgent',
            state: 'completed',
            input: {
                message: 'Search GitHub trending repositories for React state tooling',
                model: 'gpt-5.4-mini'
            },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {
                agent_id: 'agent-1',
                nickname: 'Pauli'
            }
        },
        lifecycle: {
            kind: 'codex-agent-lifecycle',
            agentId: 'agent-1',
            nickname: 'Pauli',
            status: 'waiting',
            latestText: 'Waiting for child agent to finish',
            hiddenToolIds: ['wait-1'],
            actions: [
                { type: 'wait', createdAt: 4, summary: 'Waiting for child agent to finish' }
            ]
        },
        children: [
            {
                kind: 'user-text',
                id: 'child-user-1',
                localId: null,
                createdAt: 3,
                text: 'child prompt',
                meta: undefined
            },
            {
                kind: 'agent-text',
                id: 'child-agent-1',
                localId: null,
                createdAt: 4,
                text: 'child answer',
                meta: undefined
            }
        ]
    }
}

function renderWithProviders(ui: ReactElement) {
    if (typeof window !== 'undefined' && !window.matchMedia) {
        window.matchMedia = () => ({
            matches: false,
            media: '',
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => false
        })
    }

    return render(
        <I18nProvider>
            <HappyChatProvider
                value={{
                    api: {} as never,
                    sessionId: 'session-1',
                    metadata: null,
                    disabled: false,
                    onRefresh: () => {}
                }}
            >
                {ui}
            </HappyChatProvider>
        </I18nProvider>
    )
}

afterEach(() => {
    cleanup()
})

describe('CodexSubagentPreviewCard', () => {
    it('keeps child transcript hidden until opened, then shows it in dialog', () => {
        const block = makeSpawnBlock()

        renderWithProviders(
            <CodexSubagentPreviewCard
                block={block}
            />
        )

        expect(screen.getByText('Subagent conversation')).toBeInTheDocument()
        expect(screen.getByText('Waiting')).toBeInTheDocument()
        expect(screen.getByText(/Pauli/)).toBeInTheDocument()
        expect(screen.getByText(/Waiting for child agent to finish/)).toBeInTheDocument()
        expect(screen.queryByText('child prompt')).not.toBeInTheDocument()
        expect(screen.queryByText('child answer')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Subagent conversation — Pauli · agent-1/i }))

        expect(screen.getByText('child prompt')).toBeInTheDocument()
        expect(screen.getByText('child answer')).toBeInTheDocument()
    })

    it('renders HappyToolMessage as the lifecycle card for CodexSpawnAgent', () => {
        const block = makeSpawnBlock()
        const props: any = {
            artifact: block,
            toolName: 'CodexSpawnAgent',
            argsText: '{}',
            result: block.tool.result,
            isError: false,
            status: { type: 'complete' }
        }

        renderWithProviders(
            <HappyToolMessage {...props} />
        )

        expect(screen.getByText('Subagent conversation')).toBeInTheDocument()
        expect(screen.getByText('Waiting')).toBeInTheDocument()
        expect(screen.queryByText('child prompt')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: /Subagent conversation — Pauli · agent-1/i }))

        expect(screen.getByText('child prompt')).toBeInTheDocument()
        expect(screen.getByText('child answer')).toBeInTheDocument()
    })

    it('marks CodexSpawnAgent children for preview rendering instead of inline expansion', () => {
        const block = makeSpawnBlock()
        expect(getToolChildRenderMode(block)).toBe('codex-subagent-preview')
    })
})
