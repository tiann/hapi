import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import { CursorCreatePlanView } from './CursorCreatePlanView'

describe('CursorCreatePlanView', () => {
    it('renders phase-only proposals in order without repeating their flat todos', () => {
        const input = {
            todos: [{ id: 'x', content: 'Repeated flat entry', status: 'cancelled' }],
            phases: [
                { name: 'Design', todos: [{ id: 'x', content: 'Old draft', status: 'cancelled' }] },
                { name: 'Build', todos: [{ id: 'y', content: 'Wire UI', status: 'pending' }] }
            ]
        }
        const block = { tool: { name: 'CursorCreatePlan', input } } as ToolCallBlock
        const { container } = render(<CursorCreatePlanView block={block} metadata={null} />)
        expect(container.textContent).toBe('Design⊘ Old draftBuild☐ Wire UI')
        expect(screen.queryByText('Repeated flat entry')).toBeNull()
    })
})
