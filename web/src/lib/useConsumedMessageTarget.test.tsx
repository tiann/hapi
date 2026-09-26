import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useConsumedMessageTarget } from './useConsumedMessageTarget'

function Harness(props: {
    sessionId: string
    messageId?: string
}) {
    const target = useConsumedMessageTarget(props.sessionId, props.messageId, 'search text')
    return (
        <>
            <output data-testid="target">{target.effectiveMessageId ?? ''}</output>
            <output data-testid="request-id">{target.searchRequestId}</output>
            <button type="button" onClick={target.consume}>consume</button>
        </>
    )
}

describe('useConsumedMessageTarget', () => {
    it('clears a consumed target when navigating away before returning', () => {
        const view = render(<Harness sessionId="session-a" messageId="message-a" />)

        fireEvent.click(screen.getByRole('button', { name: 'consume' }))
        view.rerender(<Harness sessionId="session-a" />)
        expect(screen.getByTestId('target')).toHaveTextContent('message-a')

        view.rerender(<Harness sessionId="session-b" />)
        view.rerender(<Harness sessionId="session-a" />)
        expect(screen.getByTestId('target')).toHaveTextContent('')
    })

    it('increments the request id when the same result is selected again', () => {
        const view = render(<Harness sessionId="session-a" messageId="message-a" />)
        const firstRequestId = Number(screen.getByTestId('request-id').textContent)

        fireEvent.click(screen.getByRole('button', { name: 'consume' }))
        view.rerender(<Harness sessionId="session-a" />)
        view.rerender(<Harness sessionId="session-a" messageId="message-a" />)

        expect(Number(screen.getByTestId('request-id').textContent)).toBeGreaterThan(firstRequestId)
    })
})
