import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MarkdownRenderer } from './MarkdownRenderer'

describe('MarkdownRenderer', () => {
    it('renders outside assistant thread message context', () => {
        render(<MarkdownRenderer content={`### Feature overview

- Works outside chat.`} />)

        expect(screen.getByRole('heading', { name: 'Feature overview' })).toBeTruthy()
        expect(screen.getByText('Works outside chat.')).toBeTruthy()
    })
})
