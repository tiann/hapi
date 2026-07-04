import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

const mermaidMocks = vi.hoisted(() => ({
    initializeMock: vi.fn(),
    parseMock: vi.fn(),
    renderMock: vi.fn(),
    setParseErrorHandlerMock: vi.fn(),
}))

vi.mock('mermaid', () => ({
    default: {
        initialize: mermaidMocks.initializeMock,
        parse: mermaidMocks.parseMock,
        render: mermaidMocks.renderMock,
        setParseErrorHandler: mermaidMocks.setParseErrorHandlerMock,
    }
}))

import { MermaidDiagram } from '@/components/assistant-ui/mermaid-diagram'
import { MARKDOWN_COMPONENTS_BY_LANGUAGE } from '@/components/assistant-ui/markdown-text'

function renderMermaid(code: string) {
    return render(
        <MermaidDiagram
            code={code}
            language="mermaid"
            components={{
                Pre: (props) => <pre {...props} />,
                Code: (props) => <code {...props} />,
            }}
        />
    )
}

describe('MermaidDiagram', () => {
    beforeEach(() => {
        mermaidMocks.initializeMock.mockClear()
        mermaidMocks.setParseErrorHandlerMock.mockClear()
        mermaidMocks.parseMock.mockReset()
        mermaidMocks.parseMock.mockResolvedValue({ diagramType: 'flowchart-v2' })
        mermaidMocks.renderMock.mockReset()
        mermaidMocks.renderMock.mockResolvedValue({
            svg: '<svg data-testid="mock-mermaid"></svg>'
        })
    })

    afterEach(() => {
        cleanup()
        document.documentElement.removeAttribute('data-theme')
    })

    it('is wired into the shared markdown language overrides and renders svg output', async () => {
        renderMermaid('graph TD\nA --> B')

        await waitFor(() => {
            const diagram = document.querySelector('[data-mermaid-diagram][data-rendered="true"]')
            expect(diagram).toBeTruthy()
            expect(diagram?.querySelector('[data-testid="mock-mermaid"]')).toBeTruthy()
        })

        expect(mermaidMocks.initializeMock).toHaveBeenCalled()
        expect(mermaidMocks.initializeMock).toHaveBeenCalledWith(expect.objectContaining({
            securityLevel: 'strict',
            suppressErrorRendering: true,
        }))
        expect(mermaidMocks.parseMock).toHaveBeenCalledWith('graph TD\nA --> B', { suppressErrors: true })
        expect(mermaidMocks.renderMock).toHaveBeenCalledWith(expect.stringContaining('mermaid-'), 'graph TD\nA --> B')
        expect(MARKDOWN_COMPONENTS_BY_LANGUAGE.mermaid.SyntaxHighlighter).toBe(MermaidDiagram)
    })

    it('falls back to source and suppresses Mermaid parse-error side effects for invalid syntax', async () => {
        document.documentElement.dataset.theme = 'dark'
        mermaidMocks.parseMock.mockResolvedValueOnce(false)

        renderMermaid('graph TD\nA --')

        await waitFor(() => {
            const fallback = document.querySelector('.aui-mermaid-fallback')
            expect(fallback).toBeTruthy()
            expect(fallback?.textContent).toBe('graph TD\nA --')
        })

        expect(mermaidMocks.parseMock).toHaveBeenCalledWith('graph TD\nA --', { suppressErrors: true })
        expect(mermaidMocks.renderMock).not.toHaveBeenCalled()
        expect(mermaidMocks.setParseErrorHandlerMock).toHaveBeenCalled()
    })

    it('falls back to source and asks Mermaid not to inject its own error SVG when render throws', async () => {
        mermaidMocks.renderMock.mockRejectedValueOnce(new Error('render failed'))
        const code = 'gantt\ndateFormat YYYY-MM-DD\nsection A\nTask :a, 2024-01-01'

        renderMermaid(code)

        await waitFor(() => {
            const fallback = document.querySelector('.aui-mermaid-fallback')
            expect(fallback).toBeTruthy()
            expect(fallback?.textContent).toBe(code)
        })

        expect(mermaidMocks.renderMock).toHaveBeenCalled()
        expect(mermaidMocks.initializeMock).toHaveBeenCalledWith(expect.objectContaining({
            suppressErrorRendering: true,
        }))
    })

    it('sanitizes Mermaid SVG before injecting it into the DOM', async () => {
        mermaidMocks.renderMock.mockResolvedValueOnce({
            svg: '<svg data-testid="mock-mermaid" onload="alert(1)"><script>alert(1)</script><text>safe</text></svg>'
        })

        renderMermaid('graph TD\nA --> B')

        await waitFor(() => {
            const diagram = document.querySelector('[data-mermaid-diagram][data-rendered="true"]')
            const svg = diagram?.querySelector('[data-testid="mock-mermaid"]')
            expect(svg).toBeTruthy()
            expect(svg?.getAttribute('onload')).toBeNull()
            expect(diagram?.querySelector('script')).toBeNull()
            expect(diagram?.textContent).toContain('safe')
        })
    })

})
