import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PeerSenderChip } from './PeerSenderChip'

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
}))

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key,
    }),
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useOptionalHappyChatContext: () => null,
}))

const mockUseSessions = vi.fn(() => ({
    sessions: [] as Array<{ id: string; metadata?: { name?: string; summary?: { text: string }; path?: string } }>,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
}))

vi.mock('@/hooks/queries/useSessions', () => ({
    useSessions: () => mockUseSessions(),
}))

describe('PeerSenderChip', () => {
    it('renders the same @title chip label as rich-composer mentions', () => {
        render(
            <PeerSenderChip
                sourceSessionId="3e387783-d48e-4a73-932a-90acebe91702"
                sourceName="hapi-inline ownership"
            />
        )
        const chip = screen.getByRole('button', { name: /hapi-inline ownership/i })
        expect(chip).toHaveTextContent('@hapi-inline ownership')
        expect(chip).toHaveAttribute('data-session-id', '3e387783-d48e-4a73-932a-90acebe91702')
        expect(chip).toHaveAttribute('data-hapi-peer-delivery', 'true')
    })

    it('backfills the label from the live session list when sourceName is missing', () => {
        const sourceId = '2e12cfee-aaaa-bbbb-cccc-dddddddddddd'
        mockUseSessions.mockReturnValue({
            sessions: [{
                id: sourceId,
                metadata: { summary: { text: 'Local Testing' } },
            }],
            isLoading: false,
            error: null,
            refetch: vi.fn(),
        })

        render(<PeerSenderChip sourceSessionId={sourceId} />)

        const chip = screen.getByRole('button', { name: /Local Testing/i })
        expect(chip).toHaveTextContent('@Local Testing')
    })

    it('renders a non-link @peer chip when source is unknown', () => {
        render(<PeerSenderChip />)
        expect(screen.getByText('message.peerUnknownChip')).toHaveAttribute(
            'data-hapi-peer-unknown',
            'true'
        )
    })
})
