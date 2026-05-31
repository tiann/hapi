import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'

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

const defaultComponents = {
    Pre: (props: ComponentProps<'pre'>) => <pre {...props} />,
    Code: (props: ComponentProps<'code'>) => <code {...props} />,
}

function renderDiagram(props: ComponentProps<typeof MermaidDiagram>) {
    return render(
        <I18nProvider>
            <MermaidDiagram {...props} />
        </I18nProvider>,
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
            svg: '<svg data-testid="mock-mermaid"></svg>',
        })
    })

    afterEach(() => {
        cleanup()
        document.documentElement.removeAttribute('data-theme')
    })

    it('is wired into the shared markdown language overrides and renders svg output', async () => {
        renderDiagram({
            code: 'graph TD\nA --> B',
            language: 'mermaid',
            components: defaultComponents,
        })

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

        renderDiagram({
            code: 'graph TD\nA --',
            language: 'mermaid',
            components: defaultComponents,
        })

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

        renderDiagram({
            code,
            language: 'mermaid',
            components: defaultComponents,
        })

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

    it('opens a zoomable lightbox when the rendered diagram is clicked', async () => {
        renderDiagram({
            code: 'graph TD\nA --> B',
            language: 'mermaid',
            components: defaultComponents,
        })

        await waitFor(() => {
            expect(document.querySelector('[data-mermaid-diagram][data-rendered="true"]')).toBeTruthy()
        })

        fireEvent.click(document.querySelector('[data-mermaid-diagram][data-rendered="true"]') as HTMLButtonElement)

        await waitFor(() => {
            const dialog = screen.getByRole('dialog', { name: 'Diagram' })
            expect(dialog.querySelector('[data-testid="mock-mermaid"]')).toBeTruthy()
        })

        expect(mermaidMocks.renderMock).toHaveBeenCalledTimes(2)
        expect(mermaidMocks.renderMock).toHaveBeenNthCalledWith(
            1,
            expect.stringContaining('mermaid-'),
            'graph TD\nA --> B',
        )
        expect(mermaidMocks.renderMock).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('mermaid-modal-'),
            'graph TD\nA --> B',
        )
    })

    it('does not expose a lightbox trigger when rendering fails', async () => {
        mermaidMocks.renderMock.mockRejectedValue(new Error('syntax'))

        renderDiagram({
            code: 'not valid mermaid',
            language: 'mermaid',
            components: defaultComponents,
        })

        await waitFor(() => {
            expect(document.querySelector('[data-mermaid-diagram][data-rendered="false"]')).toBeTruthy()
        })

        expect(screen.queryByRole('button', { name: 'Open diagram full screen' })).toBeNull()
    })
})
