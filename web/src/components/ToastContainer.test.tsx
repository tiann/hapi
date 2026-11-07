import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { ToastContainer } from './ToastContainer'
import { ToastProvider, useToast } from '@/lib/toast-context'
import { consumeExplicitSessionNavigationIntent } from '@/lib/explicitSessionNavigationIntent'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async () => {
    const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router')
    return {
        ...actual,
        useNavigate: () => navigate,
    }
})

afterEach(() => {
    cleanup()
    consumeExplicitSessionNavigationIntent() // drain any unconsumed flag between tests
})

function AddOneToast() {
    const { addToast } = useToast()
    useEffect(() => {
        addToast({ title: 'Session needs you', body: 'Permission requested', sessionId: 'session-1', url: '' })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return null
}

describe('ToastContainer', () => {
    it('marks explicit session-navigation intent before navigating to a clicked toast\'s session', () => {
        render(
            <ToastProvider>
                <AddOneToast />
                <ToastContainer />
            </ToastProvider>
        )

        fireEvent.click(screen.getByText('Session needs you'))

        expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
        }))
        // The flag must already be set by the time navigate() is called —
        // router.tsx's onBeforeNavigate subscriber reads it synchronously
        // during that same call, not after (review finding: a toast click
        // targeting a session Boards is already overlaying with an item
        // selected must exit Boards mode even though its history index can
        // coincidentally match one isHistoryPopNavigation has already seen).
        expect(consumeExplicitSessionNavigationIntent()).toBe(true)
    })
})
