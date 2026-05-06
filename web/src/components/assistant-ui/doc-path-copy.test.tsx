import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
    CopyableDocPathText,
    splitDocPathText,
} from '@/components/assistant-ui/doc-path-copy'

const clipboardMocks = vi.hoisted(() => ({
    safeCopyToClipboard: vi.fn(),
}))

vi.mock('@/lib/clipboard', () => ({
    safeCopyToClipboard: clipboardMocks.safeCopyToClipboard,
}))

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

describe('splitDocPathText', () => {
    it('splits a single docs markdown path', () => {
        expect(splitDocPathText('Plan: docs/plans/example-plan.md ready')).toEqual([
            { type: 'text', value: 'Plan: ' },
            { type: 'path', value: 'docs/plans/example-plan.md' },
            { type: 'text', value: ' ready' },
        ])
    })

    it('keeps trailing punctuation outside the path', () => {
        expect(splitDocPathText('Use docs/plans/example-plan.md.')).toEqual([
            { type: 'text', value: 'Use ' },
            { type: 'path', value: 'docs/plans/example-plan.md' },
            { type: 'text', value: '.' },
        ])
    })

    it('keeps multiple docs markdown paths distinct', () => {
        expect(splitDocPathText('Read docs/brainstorms/a.md then docs/plans/b.md')).toEqual([
            { type: 'text', value: 'Read ' },
            { type: 'path', value: 'docs/brainstorms/a.md' },
            { type: 'text', value: ' then ' },
            { type: 'path', value: 'docs/plans/b.md' },
        ])
    })

    it('ignores non-target paths', () => {
        expect(splitDocPathText('See web/src/file.tsx, scratch/file.md, README.md, docs/plans/a.mdx, and docs/plans/a.md.bak')).toEqual([
            { type: 'text', value: 'See web/src/file.tsx, scratch/file.md, README.md, docs/plans/a.mdx, and docs/plans/a.md.bak' },
        ])
    })
})

describe('CopyableDocPathText', () => {
    afterEach(() => {
        clipboardMocks.safeCopyToClipboard.mockReset()
        cleanup()
    })

    it('copies only the matching path', async () => {
        clipboardMocks.safeCopyToClipboard.mockResolvedValue(undefined)

        render(<CopyableDocPathText text="Plan: docs/plans/example-plan.md." />)

        const button = screen.getByRole('button', {
            name: 'markdown.copyDocPath docs/plans/example-plan.md',
        })
        expect(button).toHaveClass('sm:hidden')

        fireEvent.click(button)

        await waitFor(() => {
            expect(clipboardMocks.safeCopyToClipboard).toHaveBeenCalledWith('docs/plans/example-plan.md')
        })
    })

    it('renders one copy button per matched path', () => {
        render(<CopyableDocPathText text="docs/brainstorms/a.md and docs/plans/b.md" />)

        expect(screen.getByRole('button', {
            name: 'markdown.copyDocPath docs/brainstorms/a.md',
        })).toBeInTheDocument()
        expect(screen.getByRole('button', {
            name: 'markdown.copyDocPath docs/plans/b.md',
        })).toBeInTheDocument()
    })

    it('does not throw when clipboard copy fails', async () => {
        clipboardMocks.safeCopyToClipboard.mockRejectedValue(new Error('denied'))

        render(<CopyableDocPathText text="docs/plans/example-plan.md" />)

        fireEvent.click(screen.getByRole('button', {
            name: 'markdown.copyDocPath docs/plans/example-plan.md',
        }))

        await waitFor(() => {
            expect(clipboardMocks.safeCopyToClipboard).toHaveBeenCalledWith('docs/plans/example-plan.md')
        })
        expect(screen.getByText('docs/plans/example-plan.md')).toBeInTheDocument()
    })
})
