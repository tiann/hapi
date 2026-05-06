import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const mermaidMocks = vi.hoisted(() => ({
    initializeMock: vi.fn(),
    renderMock: vi.fn().mockResolvedValue({
        svg: '<svg data-testid="mock-mermaid"></svg>'
    })
}))

vi.mock('mermaid', () => ({
    default: {
        initialize: mermaidMocks.initializeMock,
        render: mermaidMocks.renderMock,
    }
}))

import { MermaidDiagram } from '@/components/assistant-ui/mermaid-diagram'
import { MARKDOWN_COMPONENTS_BY_LANGUAGE } from '@/components/assistant-ui/markdown-text'

describe('MermaidDiagram', () => {
    it('is wired into the shared markdown language overrides and renders svg output', async () => {
        render(
            <MermaidDiagram
                code={'graph TD\nA --> B'}
                language="mermaid"
                components={{
                    Pre: (props) => <pre {...props} />,
                    Code: (props) => <code {...props} />,
                }}
            />
        )

        await waitFor(() => {
            const diagram = document.querySelector('[data-mermaid-diagram][data-rendered="true"]')
            expect(diagram).toBeTruthy()
            expect(diagram?.querySelector('[data-testid="mock-mermaid"]')).toBeTruthy()
        })

        expect(mermaidMocks.initializeMock).toHaveBeenCalled()
        expect(mermaidMocks.initializeMock).toHaveBeenCalledWith(expect.objectContaining({
            securityLevel: 'strict'
        }))
        expect(mermaidMocks.renderMock).toHaveBeenCalledWith(expect.stringContaining('mermaid-'), 'graph TD\nA --> B')
        expect(MARKDOWN_COMPONENTS_BY_LANGUAGE.mermaid.SyntaxHighlighter).toBe(MermaidDiagram)
    })
})
