import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ScrollableTitle } from './ScrollableTitle'

function renderTitle(text = 'A very long title that needs horizontal scrolling') {
    return render(
        <ScrollableTitle
            text={text}
            testId="scrollable-title"
        />
    )
}

function setDimensions(element: HTMLElement, clientWidth: number, scrollWidth: number) {
    Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth })
    Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth })
}

describe('ScrollableTitle', () => {
    it('keeps the title as a horizontally scrollable, single-line region', async () => {
        renderTitle()

        const region = screen.getByTestId('scrollable-title')
        setDimensions(region, 120, 320)
        fireEvent.resize(window)

        await waitFor(() => expect(region).toHaveClass('overflow-x-auto', 'whitespace-nowrap'))
        expect(region).toHaveClass('hapi-scrollable-surface')
        expect(region).toHaveAttribute('role', 'region')
        expect(region).toHaveAttribute('tabindex', '0')
        expect(region).toHaveTextContent('A very long title that needs horizontal scrolling')
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
        expect(screen.getByTestId('scrollable-title-end-fade')).toBeInTheDocument()
    })

    it('moves the edge gradients with the native horizontal scroll position', async () => {
        renderTitle()

        const region = screen.getByTestId('scrollable-title')
        setDimensions(region, 120, 320)
        fireEvent.resize(window)
        await waitFor(() => expect(region).toHaveAttribute('role', 'region'))

        region.scrollLeft = 200
        fireEvent.scroll(region)

        await waitFor(() => {
            expect(screen.getByTestId('scrollable-title-start-fade')).toBeInTheDocument()
            expect(screen.queryByTestId('scrollable-title-end-fade')).not.toBeInTheDocument()
        })
    })

    it('does not add an overflow affordance when the title fits', async () => {
        renderTitle('Short title')

        const region = screen.getByTestId('scrollable-title')
        setDimensions(region, 240, 240)
        fireEvent.resize(window)

        await waitFor(() => expect(region).not.toHaveAttribute('role', 'region'))
        expect(screen.queryByRole('button')).not.toBeInTheDocument()
    })

    it('resets the horizontal position when the title changes', async () => {
        const view = renderTitle()
        const region = screen.getByTestId('scrollable-title')
        setDimensions(region, 120, 320)
        fireEvent.resize(window)
        await waitFor(() => expect(region).toHaveAttribute('role', 'region'))

        region.scrollLeft = 80
        view.rerender(
            <ScrollableTitle
                text="A replacement title"
                testId="scrollable-title"
            />
        )

        expect(screen.getByTestId('scrollable-title').scrollLeft).toBe(0)
    })
})
