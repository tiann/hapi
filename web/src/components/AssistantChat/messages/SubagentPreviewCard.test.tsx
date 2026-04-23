import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { SubagentPreviewCard } from './SubagentPreviewCard'

function spawnBlock(props: {
    id: string
    agentId: string
    nickname: string
    message?: string
}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: props.id,
        localId: null,
        createdAt: 1,
        tool: {
            id: props.id,
            name: 'CodexSpawnAgent',
            state: 'completed',
            input: {
                message: props.message ?? 'Inspect the current behavior'
            },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {
                agent_id: props.agentId,
                nickname: props.nickname
            }
        },
        children: []
    }
}

describe('SubagentPreviewCard', () => {
    afterEach(() => {
        cleanup()
    })

    it('promotes the nickname ahead of the repeated subagent label', () => {
        render(<SubagentPreviewCard block={spawnBlock({ id: 'spawn-1', agentId: 'agent-1', nickname: 'Pasteur' })} />)

        const button = screen.getByRole('button', { name: /Pasteur/ })
        const title = screen.getByRole('heading', { name: 'Pasteur' })
        const label = screen.getByText('Subagent conversation')

        expect(button.textContent?.indexOf('Pasteur')).toBeLessThan(button.textContent?.indexOf('Subagent conversation') ?? -1)
        expect(title.className).toContain('text-base')
        expect(label.className).toContain('text-[11px]')
    })

    it('assigns stable different accents to different subagents', () => {
        const { container } = render(
            <>
                <SubagentPreviewCard block={spawnBlock({ id: 'spawn-1', agentId: 'agent-1', nickname: 'Pasteur' })} />
                <SubagentPreviewCard block={spawnBlock({ id: 'spawn-2', agentId: 'agent-2', nickname: 'Curie' })} />
            </>
        )

        const cards = Array.from(container.querySelectorAll('[data-subagent-accent]'))
        expect(cards).toHaveLength(2)
        expect(cards[0].getAttribute('data-subagent-accent')).not.toBe(cards[1].getAttribute('data-subagent-accent'))
    })
})
