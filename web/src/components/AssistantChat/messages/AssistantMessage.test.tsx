import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const harness = vi.hoisted(() => ({
    message: {
        role: 'assistant',
        metadata: { custom: {} },
        content: [{ type: 'text', text: 'Assistant reply' }],
        createdAt: new Date(2026, 4, 18, 14, 13, 9)
    } as any
}))

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ className, children }: { className?: string; children: ReactNode }) => (
            <div data-testid="message-root" className={className}>{children}</div>
        ),
        Content: () => <div data-testid="message-content">Assistant reply</div>
    },
    useAssistantState: (selector: (state: { message: typeof harness.message }) => unknown) => selector({
        message: harness.message
    })
}))

vi.mock('@/components/assistant-ui/markdown-text', () => ({
    MarkdownText: () => null
}))

vi.mock('@/components/assistant-ui/reasoning', () => ({
    Reasoning: () => null,
    ReasoningGroup: () => null
}))

vi.mock('@/components/AssistantChat/messages/ToolMessage', () => ({
    HappyToolMessage: () => null
}))

vi.mock('@/components/CliOutputBlock', () => ({
    CliOutputBlock: () => null
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({
        copied: false,
        copy: vi.fn()
    })
}))

import { HappyAssistantMessage } from './AssistantMessage'

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    harness.message = {
        role: 'assistant',
        metadata: { custom: {} },
        content: [{ type: 'text', text: 'Assistant reply' }],
        createdAt: new Date(2026, 4, 18, 14, 13, 9)
    }
    vi.useRealTimers()
})

describe('HappyAssistantMessage copy control', () => {

    it('renders the assistant message timestamp from createdAt', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 4, 18, 15, 0, 0))
        harness.message = {
            role: 'assistant',
            metadata: { custom: {} },
            content: [{ type: 'text', text: 'Assistant reply' }],
            createdAt: new Date(2026, 4, 18, 14, 13, 9)
        }

        render(<HappyAssistantMessage />)

        const timestamp = screen.getByText('14:13')
        expect(timestamp.tagName).toBe('TIME')
        expect(timestamp).toHaveAttribute('title', '2026-05-18 14:13:09')
        expect(timestamp).toHaveAttribute('dateTime', new Date(2026, 4, 18, 14, 13, 9).toISOString())
    })

    it('renders assistant timestamps from final completion metadata instead of reply start time', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 4, 18, 15, 0, 0))
        harness.message = {
            role: 'assistant',
            metadata: {
                custom: {
                    kind: 'assistant',
                    timestampSource: 'completion',
                    timestampAt: new Date(2026, 4, 18, 14, 15, 40).getTime()
                }
            },
            content: [{ type: 'text', text: 'Assistant reply' }],
            createdAt: new Date(2026, 4, 18, 14, 13, 9)
        }

        render(<HappyAssistantMessage />)

        const timestamp = screen.getByText('14:15')
        expect(timestamp).toHaveAttribute('title', '2026-05-18 14:15:40')
        expect(screen.queryByText('14:13')).not.toBeInTheDocument()
    })

    it('hides assistant timestamps while the completion timestamp is still pending', () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date(2026, 4, 18, 15, 0, 0))
        harness.message = {
            role: 'assistant',
            metadata: {
                custom: {
                    kind: 'assistant',
                    timestampSource: 'completion',
                    timestampAt: null
                }
            },
            content: [{ type: 'text', text: 'Assistant reply' }],
            createdAt: new Date(2026, 4, 18, 14, 13, 9)
        }

        render(<HappyAssistantMessage />)

        expect(screen.queryByText('14:13')).not.toBeInTheDocument()
    })

    it('keeps assistant copy control visible on mobile and hover-only on desktop', () => {
        render(<HappyAssistantMessage />)

        const copyButton = screen.getByTitle('Copy')
        const copyContainer = copyButton.parentElement

        expect(copyContainer).not.toBeNull()
        expect(copyContainer).not.toHaveClass('hidden')
        expect(copyContainer).not.toHaveClass('sm:flex')
        expect(copyContainer).toHaveClass('flex')
        expect(copyContainer).toHaveClass('opacity-60')
        expect(copyContainer).toHaveClass('sm:opacity-0')
        expect(copyContainer).toHaveClass('sm:group-hover/msg:opacity-100')
    })

    it('does not render a copy control when assistant text is empty', () => {
        harness.message = {
            role: 'assistant',
            metadata: { custom: {} },
            content: [{ type: 'text', text: '   ' }]
        }

        render(<HappyAssistantMessage />)

        expect(screen.queryByTitle('Copy')).not.toBeInTheDocument()
    })

    it('renders MoA reference data parts as model-labelled details collapsed by default', () => {
        harness.message = {
            role: 'assistant',
            metadata: {
                custom: {
                    kind: 'moa-reference'
                }
            },
            content: [{
                type: 'data',
                name: 'hapi-moa-reference',
                data: {
                    label: 'openai-codex:gpt-5.5',
                    text: 'Reference answer',
                    index: 1,
                    count: 3
                }
            }]
        }

        render(<HappyAssistantMessage />)

        const details = screen.getByTestId('moa-reference-details') as HTMLDetailsElement
        expect(details.open).toBe(false)
        expect(screen.getByText('MoA reference 1/3 · openai-codex:gpt-5.5')).toBeInTheDocument()

        fireEvent.click(screen.getByText('MoA reference 1/3 · openai-codex:gpt-5.5'))
        expect(details.open).toBe(true)
        expect(screen.getByText('Reference answer')).toBeInTheDocument()
    })

    it('renders every MoA reference data part when assistant-ui merges consecutive reference messages', () => {
        harness.message = {
            role: 'assistant',
            metadata: {
                custom: {
                    kind: 'moa-reference'
                }
            },
            content: [
                {
                    type: 'data',
                    name: 'hapi-moa-reference',
                    data: {
                        label: 'openai-codex:gpt-5.5',
                        text: 'Codex reference',
                        index: 1,
                        count: 3
                    }
                },
                {
                    type: 'data',
                    name: 'hapi-moa-reference',
                    data: {
                        label: 'deepseek:deepseek-v4-pro',
                        text: 'DeepSeek reference',
                        index: 2,
                        count: 3
                    }
                },
                {
                    type: 'data',
                    name: 'hapi-moa-reference',
                    data: {
                        label: 'agy:Gemini 3.5 Flash (High)',
                        text: 'Agy reference',
                        index: 3,
                        count: 3
                    }
                }
            ]
        }

        render(<HappyAssistantMessage />)

        expect(screen.getAllByTestId('moa-reference-details')).toHaveLength(3)
        expect(screen.getByText('MoA reference 1/3 · openai-codex:gpt-5.5')).toBeInTheDocument()
        expect(screen.getByText('MoA reference 2/3 · deepseek:deepseek-v4-pro')).toBeInTheDocument()
        expect(screen.getByText('MoA reference 3/3 · agy:Gemini 3.5 Flash (High)')).toBeInTheDocument()
    })

    it('renders assistant attachments from message metadata with a stable download dialog', () => {
        harness.message = {
            role: 'assistant',
            metadata: {
                custom: {
                    attachments: [{
                        id: 'agent-att-1',
                        filename: 'report.csv',
                        mimeType: 'text/csv',
                        size: 8,
                        path: 'hapi-agent-inline://agent-att-1/report.csv',
                        previewUrl: 'data:text/csv;base64,YSxiCjEsMgo='
                    }]
                }
            },
            content: [{ type: 'text', text: '' }]
        }

        render(<HappyAssistantMessage />)

        expect(screen.getByText('report.csv')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /open attachment actions for report\.csv/i }))
        expect(screen.getByRole('link', { name: /download report\.csv/i })).toHaveAttribute('download', 'report.csv')
    })

    it('renders assistant attachments from data content parts when message metadata is missing after merge', () => {
        harness.message = {
            role: 'assistant',
            metadata: {
                custom: {
                    kind: 'assistant'
                }
            },
            content: [
                { type: 'text', text: 'Tool output around this attachment' },
                {
                    type: 'data',
                    name: 'hapi-agent-attachments',
                    data: {
                        attachments: [{
                            id: 'merged-agent-att-1',
                            filename: 'merged-report.csv',
                            mimeType: 'text/csv',
                            size: 12,
                            path: 'hapi-agent-inline://merged-agent-att-1/merged-report.csv',
                            previewUrl: 'data:text/csv;base64,YSxiCjEsMgo='
                        }]
                    }
                }
            ]
        }

        render(<HappyAssistantMessage />)

        expect(screen.getByText('merged-report.csv')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /open attachment actions for merged-report\.csv/i }))
        expect(screen.getByRole('link', { name: /download merged-report\.csv/i })).toHaveAttribute('download', 'merged-report.csv')
    })

    it('prefers assistant attachments from data content parts over metadata fallback', () => {
        harness.message = {
            role: 'assistant',
            metadata: {
                custom: {
                    kind: 'assistant',
                    attachments: [{
                        id: 'fallback-agent-att-1',
                        filename: 'metadata-fallback.csv',
                        mimeType: 'text/csv',
                        size: 8,
                        path: 'hapi-agent-inline://fallback-agent-att-1/metadata-fallback.csv',
                        previewUrl: 'data:text/csv;base64,YSxiCg=='
                    }]
                }
            },
            content: [{
                type: 'data',
                name: 'hapi-agent-attachments',
                data: {
                    attachments: [{
                        id: 'content-agent-att-1',
                        filename: 'content-primary.csv',
                        mimeType: 'text/csv',
                        size: 12,
                        path: 'hapi-agent-inline://content-agent-att-1/content-primary.csv',
                        previewUrl: 'data:text/csv;base64,YSxiCjEsMgo='
                    }]
                }
            }]
        }

        render(<HappyAssistantMessage />)

        expect(screen.getByText('content-primary.csv')).toBeInTheDocument()
        expect(screen.queryByText('metadata-fallback.csv')).not.toBeInTheDocument()
    })

    it('renders data-only assistant attachments without an empty message content block', () => {
        harness.message = {
            role: 'assistant',
            metadata: {
                custom: {
                    kind: 'assistant'
                }
            },
            content: [{
                type: 'data',
                name: 'hapi-agent-attachments',
                data: {
                    attachments: [{
                        id: 'data-only-agent-att-1',
                        filename: 'data-only-report.csv',
                        mimeType: 'text/csv',
                        size: 12,
                        path: 'hapi-agent-inline://data-only-agent-att-1/data-only-report.csv',
                        previewUrl: 'data:text/csv;base64,YSxiCjEsMgo='
                    }]
                }
            }]
        }

        render(<HappyAssistantMessage />)

        expect(screen.getByText('data-only-report.csv')).toBeInTheDocument()
        expect(screen.queryByTestId('message-content')).not.toBeInTheDocument()
        expect(screen.queryByTitle('Copy')).not.toBeInTheDocument()
    })

    it('ignores malformed text content parts without throwing', () => {
        harness.message = {
            role: 'assistant',
            metadata: { custom: {} },
            content: [{ type: 'text', text: null }]
        }

        render(<HappyAssistantMessage />)

        expect(screen.queryByTitle('Copy')).not.toBeInTheDocument()
    })

})
