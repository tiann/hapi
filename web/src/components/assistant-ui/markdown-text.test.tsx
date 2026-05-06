import type { ComponentType, HTMLAttributes } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

const markdownMocks = vi.hoisted(() => ({
    isCodeBlock: false,
}))

vi.mock('@assistant-ui/react-markdown', async () => {
    const actual = await vi.importActual<typeof import('@assistant-ui/react-markdown')>('@assistant-ui/react-markdown')
    return {
        ...actual,
        useIsMarkdownCodeBlock: () => markdownMocks.isCodeBlock,
    }
})

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTelegram: false,
        isTouch: true,
        haptic: {
            impact: vi.fn(),
            notification: vi.fn(),
            selection: vi.fn(),
        },
    }),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string, params?: Record<string, string | number>) => (
            params?.path ? `${key} ${params.path}` : key
        ),
    }),
}))

import {
    assistantMessageComponents,
    defaultComponents,
} from '@/components/assistant-ui/markdown-text'

type TextComponent = ComponentType<HTMLAttributes<HTMLElement>>

function component(name: 'p' | 'code'): TextComponent {
    return assistantMessageComponents[name] as TextComponent
}

describe('assistant markdown doc path copy', () => {
    afterEach(() => {
        markdownMocks.isCodeBlock = false
        cleanup()
    })

    it('adds a mobile copy button to docs markdown paths in normal text', () => {
        const P = component('p')

        render(<P>Plan written: docs/plans/example-plan.md</P>)

        const button = screen.getByRole('button', {
            name: 'markdown.copyDocPath docs/plans/example-plan.md',
        })
        expect(button).toHaveClass('sm:hidden')
    })

    it('adds a mobile copy button to docs markdown paths in inline code', () => {
        const Code = component('code')

        render(<Code>docs/plans/example-plan.md</Code>)

        expect(screen.getByRole('button', {
            name: 'markdown.copyDocPath docs/plans/example-plan.md',
        })).toBeInTheDocument()
    })

    it('does not add per-path copy buttons inside code blocks', () => {
        markdownMocks.isCodeBlock = true
        const Code = component('code')

        render(<Code>docs/plans/example-plan.md</Code>)

        expect(screen.queryByRole('button', {
            name: 'markdown.copyDocPath docs/plans/example-plan.md',
        })).not.toBeInTheDocument()
    })

    it('does not enhance default markdown components', () => {
        const P = defaultComponents.p as TextComponent

        render(<P>Plan written: docs/plans/example-plan.md</P>)

        expect(screen.queryByRole('button', {
            name: 'markdown.copyDocPath docs/plans/example-plan.md',
        })).not.toBeInTheDocument()
    })

    it('adds independent controls for multiple docs markdown paths', () => {
        const P = component('p')

        render(<P>Read docs/brainstorms/a.md and docs/plans/b.md</P>)

        expect(screen.getByRole('button', {
            name: 'markdown.copyDocPath docs/brainstorms/a.md',
        })).toBeInTheDocument()
        expect(screen.getByRole('button', {
            name: 'markdown.copyDocPath docs/plans/b.md',
        })).toBeInTheDocument()
    })
})
