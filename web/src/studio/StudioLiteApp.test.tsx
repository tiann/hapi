import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import StudioLiteApp from './StudioLiteApp'
import type { PublicStudioResponse } from '@/types/api'

function studioResponse(): PublicStudioResponse {
    const longText = Array.from({ length: 16 }, (_, index) => `Line ${index + 1}: detailed response`).join('\n')
    return {
        room: {
            id: 'room-1',
            title: 'Review studio',
            accessMode: 'contribute',
            active: true,
            agent: 'codex',
            model: 'test-model',
            createdAt: 1,
            updatedAt: 1
        },
        messages: [
            { id: 'assistant-old', role: 'assistant', text: longText, createdAt: 1, seq: 1 },
            { id: 'user-1', role: 'user', text: 'Continue', createdAt: 2, seq: 2 },
            { id: 'assistant-latest', role: 'assistant', text: longText, createdAt: 3, seq: 3 }
        ],
        posts: []
    }
}

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    localStorage.clear()
})

describe('StudioLiteApp', () => {
    it('opens at the latest message and collapses only historical long responses', async () => {
        window.history.replaceState({}, '', '/studio/token-1')
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => studioResponse()
        })) as unknown as typeof fetch)
        const scrollTo = vi.fn()
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value: scrollTo
        })

        render(<StudioLiteApp />)

        expect(await screen.findByText('Review studio')).toBeInTheDocument()
        await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' }))

        expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
        expect(screen.getAllByRole('button', { name: 'Show less' })).toHaveLength(2)
    })
})
