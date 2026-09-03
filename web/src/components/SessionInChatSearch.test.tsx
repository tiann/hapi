import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionInChatSearch } from './SessionInChatSearch'

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

function renderSearch(api: ApiClient, onSelectMatch = vi.fn()) {
    return render(
        <QueryClientProvider client={new QueryClient()}>
            <I18nProvider>
                <SessionInChatSearch
                    api={api}
                    sessionId="session-1"
                    onSelectMatch={onSelectMatch}
                />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('SessionInChatSearch', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true })
    })

    it('stays collapsed until the search toggle is pressed', () => {
        const api = {
            searchSessionContentMatches: vi.fn(),
        } as unknown as ApiClient

        renderSearch(api)

        expect(screen.getByTestId('session-in-chat-search-toggle')).toBeInTheDocument()
        expect(screen.queryByTestId('session-in-chat-search-input')).not.toBeInTheDocument()
        expect(api.searchSessionContentMatches).not.toHaveBeenCalled()
    })

    it('searches the open session and jumps when a ranked hit is chosen', async () => {
        const onSelectMatch = vi.fn()
        const createdAt = Date.now() - 3 * 60 * 60 * 1000
        const api = {
            searchSessionContentMatches: vi.fn().mockResolvedValue({
                matches: [
                    {
                        messageId: 'msg-hit',
                        role: 'user',
                        seq: 12,
                        createdAt,
                        snippet: '…enough surrounding context that the needle stands out in the transcript…',
                    },
                ],
                total: 1,
            }),
        } as unknown as ApiClient

        renderSearch(api, onSelectMatch)

        fireEvent.click(screen.getByTestId('session-in-chat-search-toggle'))
        const input = screen.getByTestId('session-in-chat-search-input')
        fireEvent.change(input, { target: { value: 'needle' } })

        await act(async () => {
            await vi.advanceTimersByTimeAsync(350)
        })

        await waitFor(() => {
            expect(api.searchSessionContentMatches).toHaveBeenCalledWith(
                'session-1',
                'needle',
                50,
                expect.any(AbortSignal)
            )
        })

        const hit = await screen.findByTestId('session-in-chat-search-hit-msg-hit')
        expect(screen.getByTestId('session-in-chat-search-hit-age-msg-hit')).toBeInTheDocument()
        expect(hit).toHaveTextContent(/enough surrounding context/i)
        expect(hit.querySelector('mark.hapi-message-search-target')).toHaveTextContent('needle')
        fireEvent.click(hit)

        expect(onSelectMatch).toHaveBeenCalledWith('msg-hit', 'needle')
    })

    it('does not query until the term is at least 2 characters', async () => {
        const api = {
            searchSessionContentMatches: vi.fn(),
        } as unknown as ApiClient

        renderSearch(api)
        fireEvent.click(screen.getByTestId('session-in-chat-search-toggle'))
        fireEvent.change(screen.getByTestId('session-in-chat-search-input'), {
            target: { value: 'n' },
        })

        await act(async () => {
            await vi.advanceTimersByTimeAsync(350)
        })

        expect(api.searchSessionContentMatches).not.toHaveBeenCalled()
        expect(screen.getByText(/at least 2 characters/i)).toBeInTheDocument()
    })
})
