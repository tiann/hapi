import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string; smooth?: boolean }) => (
        <div
            data-testid="markdown-renderer"
            data-smooth={String(props.smooth)}
        >
            {props.content}
        </div>
    ),
}))

import { LazyRainbowText } from './LazyRainbowText'

describe('LazyRainbowText', () => {
    it('renders completed user text without the streaming typewriter effect', () => {
        render(<LazyRainbowText text="complete user message" />)

        expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-smooth', 'false')
        expect(screen.getByText('complete user message')).toBeInTheDocument()
    })
})
