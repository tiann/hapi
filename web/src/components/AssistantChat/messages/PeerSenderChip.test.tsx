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

    it('renders a non-link @peer chip when source is unknown', () => {
        render(<PeerSenderChip />)
        expect(screen.getByText('message.peerUnknownChip')).toHaveAttribute(
            'data-hapi-peer-unknown',
            'true'
        )
    })
})
