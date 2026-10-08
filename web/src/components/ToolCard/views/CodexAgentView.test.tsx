import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { getToolFullViewComponent } from './_all'
import type { ToolCallBlock } from '@/chat/types'
import en from '@/lib/locales/en'
const copy = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/hooks/useCopyToClipboard', () => ({ useCopyToClipboard: () => ({ copied: false, copy }) }))
vi.mock('@/lib/use-translation', () => ({ useTranslation: () => ({ t: (key: string) => (en as Record<string, string>)[key] ?? key }) }))

describe('Codex agent details', () => {
    it('renders complete long identity with accessible ID copy, and does not infer a role', () => {
        const id = 'child-12345678-abcdef-full-identity'
        const path = '/root/' + 'long_task_'.repeat(30)
        const View = getToolFullViewComponent('CodexAgent')!
        const block = { tool: { name: 'CodexAgent', input: { agentId: id, agentStatus: 'completed', agentIdentity: { taskName: 'analyst_298', nickname: 'Aristotle', agentPath: path }, agentExecution: { model: 'actual', reasoningEffort: 'high' } } } } as unknown as ToolCallBlock
        render(<View block={block} metadata={null} surface="dialog" />)
        expect(screen.getByText(path)).toHaveClass('break-all')
        expect(screen.getByText(id)).toBeVisible()
        expect(screen.queryByText('Role:')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Copy Agent ID' }))
        expect(copy).toHaveBeenCalledWith(id)
    })
})
