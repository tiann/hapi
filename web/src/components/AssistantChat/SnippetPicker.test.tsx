import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ComposerSnippetSlot } from '@/lib/composer-snippets'
import type { RecentUserMessage } from '@/types/api'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string, params?: Record<string, unknown>) => {
            const translations: Record<string, string> = {
                'composer.snippets.saved': 'Saved snippets',
                'composer.snippets.placeholder': 'Write saved snippet',
                'composer.snippets.edit': 'Edit',
                'composer.snippets.delete': 'Delete',
                'composer.snippets.emptySlot': `Slot ${params?.index}`,
                'composer.snippets.add': 'Add',
                'composer.snippets.recent': 'Recent messages',
                'composer.snippets.loading': 'Loading recent messages',
                'composer.snippets.noRecent': 'No recent messages',
                'button.cancel': 'Cancel',
                'button.save': 'Save'
            }
            return translations[key] ?? key
        }
    })
}))

import { SnippetPicker } from './SnippetPicker'

function renderPicker(overrides: Partial<Parameters<typeof SnippetPicker>[0]> = {}) {
    const snippets: ComposerSnippetSlot[] = [
        null,
        { id: 'slot-1', text: 'Saved prompt', updatedAt: 1 },
        null,
        null,
        null
    ]
    const recentMessages: RecentUserMessage[] = [
        { id: 'message-2', seq: 2, createdAt: 20, text: 'Recent prompt' }
    ]
    const props: Parameters<typeof SnippetPicker>[0] = {
        snippets,
        recentMessages,
        recentLoading: false,
        recentError: null,
        onSelect: vi.fn(),
        onSaveSnippet: vi.fn(),
        onDeleteSnippet: vi.fn(),
        ...overrides
    }

    render(<SnippetPicker {...props} />)
    return props
}

afterEach(() => {
    cleanup()
    vi.clearAllMocks()
})

describe('SnippetPicker', () => {
    it('delegates scrolling to the floating overlay instead of creating a nested scrollbar', () => {
        const { container } = render(<SnippetPicker
            snippets={[null, null, null, null, null]}
            recentMessages={[]}
            recentLoading={false}
            recentError={null}
            onSelect={vi.fn()}
            onSaveSnippet={vi.fn()}
            onDeleteSnippet={vi.fn()}
        />)

        expect(container.firstElementChild).not.toHaveClass('overflow-y-auto')
        expect(container.firstElementChild?.className).not.toContain('max-h-')
    })

    it('renders five fixed snippet slots', () => {
        renderPicker()

        expect(screen.getByText('Saved snippets')).toBeInTheDocument()
        expect(screen.getByText('Slot 1')).toBeInTheDocument()
        expect(screen.getByText('Saved prompt')).toBeInTheDocument()
        expect(screen.getByText('Slot 3')).toBeInTheDocument()
        expect(screen.getByText('Slot 4')).toBeInTheDocument()
        expect(screen.getByText('Slot 5')).toBeInTheDocument()
    })

    it('selects a saved snippet without editing it', () => {
        const props = renderPicker()

        fireEvent.click(screen.getByText('Saved prompt'))

        expect(props.onSelect).toHaveBeenCalledWith('Saved prompt')
        expect(props.onSaveSnippet).not.toHaveBeenCalled()
    })

    it('opens an empty slot for editing and saves it to that slot', () => {
        const props = renderPicker()

        fireEvent.click(screen.getByText('Slot 1'))
        fireEvent.change(screen.getByPlaceholderText('Write saved snippet'), {
            target: { value: 'New fixed text' }
        })
        fireEvent.click(screen.getByText('Save'))

        expect(props.onSaveSnippet).toHaveBeenCalledWith(0, 'New fixed text')
    })

    it('selects a recent message', () => {
        const props = renderPicker()

        fireEvent.click(screen.getByText('Recent prompt'))

        expect(props.onSelect).toHaveBeenCalledWith('Recent prompt')
    })

    it('shows loading, empty, and error states for recent messages', () => {
        const { rerender } = render(
            <SnippetPicker
                snippets={[null, null, null, null, null]}
                recentMessages={[]}
                recentLoading
                recentError={null}
                onSelect={vi.fn()}
                onSaveSnippet={vi.fn()}
                onDeleteSnippet={vi.fn()}
            />
        )

        expect(screen.getByText('Loading recent messages')).toBeInTheDocument()

        rerender(
            <SnippetPicker
                snippets={[null, null, null, null, null]}
                recentMessages={[]}
                recentLoading={false}
                recentError={null}
                onSelect={vi.fn()}
                onSaveSnippet={vi.fn()}
                onDeleteSnippet={vi.fn()}
            />
        )
        expect(screen.getByText('No recent messages')).toBeInTheDocument()

        rerender(
            <SnippetPicker
                snippets={[null, null, null, null, null]}
                recentMessages={[]}
                recentLoading={false}
                recentError="Could not load"
                onSelect={vi.fn()}
                onSaveSnippet={vi.fn()}
                onDeleteSnippet={vi.fn()}
            />
        )
        expect(screen.getByText('Could not load')).toBeInTheDocument()
    })
})
