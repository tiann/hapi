import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { shouldShowComposerStatusBar, StatusBar } from './StatusBar'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

afterEach(cleanup)

describe('shouldShowComposerStatusBar', () => {
    it('hides the composer status bar for Cursor sessions', () => {
        expect(shouldShowComposerStatusBar('cursor')).toBe(false)
    })

    it('shows the composer status bar for other agents', () => {
        expect(shouldShowComposerStatusBar('claude')).toBe(true)
        expect(shouldShowComposerStatusBar('codex')).toBe(true)
        expect(shouldShowComposerStatusBar(null)).toBe(true)
    })
})

describe('Codex Fast badge', () => {
    function renderStatusBar(props: {
        model?: string
        modelReasoningEffort?: string
        serviceTier?: string | null
    }) {
        render(
            <StatusBar
                active
                thinking={false}
                agentState={null}
                agentFlavor="codex"
                {...props}
            />
        )
    }

    it('does not infer Fast from low reasoning when the service tier is unset', () => {
        renderStatusBar({ modelReasoningEffort: 'low' })
        expect(screen.queryByText('fast')).not.toBeInTheDocument()
    })

    it('does not infer Fast from a mini model when the service tier is unset', () => {
        renderStatusBar({ model: 'gpt-5.4-mini' })
        expect(screen.queryByText('fast')).not.toBeInTheDocument()
    })

    it('shows Fast for the explicit Fast service tier', () => {
        renderStatusBar({ serviceTier: 'fast' })
        expect(screen.getByText('fast')).toBeInTheDocument()
    })

    it('does not show Fast for the explicit Standard service tier', () => {
        renderStatusBar({ serviceTier: 'standard' })
        expect(screen.queryByText('fast')).not.toBeInTheDocument()
    })
})
