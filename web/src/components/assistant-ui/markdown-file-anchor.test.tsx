import { fireEvent, render, screen } from '@testing-library/react'
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultComponents, UriConfirmProvider } from '@/components/assistant-ui/markdown-text'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useOptionalHappyChatContext: () => ({ sessionId: 'session-1' }),
}))

const AnchorComponent = (defaultComponents as Record<string, unknown>).a as React.ComponentType<
    React.ComponentPropsWithoutRef<'a'>
>

function renderFileAnchor(filePath: string) {
    return render(
        <I18nProvider>
            <UriConfirmProvider>
                <AnchorComponent href={`hapi-file:${encodeURIComponent(filePath)}`}>
                    {filePath}
                </AnchorComponent>
            </UriConfirmProvider>
        </I18nProvider>
    )
}

beforeEach(() => {
    mocks.navigate.mockReset()
})

describe('chat file anchors', () => {
    it('marks file previews as originating from chat for deterministic back navigation', () => {
        const filePath = 'docs/guide.md'
        renderFileAnchor(filePath)
        const link = screen.getByRole('link', { name: filePath })
        const href = new URL(link.getAttribute('href')!, 'https://hapi.example')

        expect(href.pathname).toBe('/sessions/session-1/file')
        expect(href.searchParams.get('path')).toBe(encodeBase64(filePath))
        expect(href.searchParams.get('origin')).toBe('chat')

        fireEvent.click(link)

        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: {
                path: encodeBase64(filePath),
                origin: 'chat',
            },
        })
    })
})
