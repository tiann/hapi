import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toast } from './Toast'

afterEach(cleanup)

describe('Toast', () => {
    it('runs its action without triggering the toast click', () => {
        const onAction = vi.fn()
        const onToastClick = vi.fn()
        render(<Toast title="Session archived" body="Fix login" onClick={onToastClick} action={{ label: 'Reopen', onClick: onAction }} />)
        fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
        expect(onAction).toHaveBeenCalledOnce()
        expect(onToastClick).not.toHaveBeenCalled()
    })
})
