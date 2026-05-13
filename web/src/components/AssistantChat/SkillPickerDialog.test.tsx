import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { SkillSummary } from '@/types/api'
import { markSkillUsed } from '@/lib/recent-skills'
import { skillToSearchResult } from '@/lib/skill-search'
import { SkillPickerDialog } from './SkillPickerDialog'

const reviewSkill: SkillSummary = {
    name: 'review',
    description: 'Review code changes.',
    scope: 'repo',
    path: '/repo/review/SKILL.md',
}

const planSkill: SkillSummary = {
    name: 'compound-engineering:ce-plan',
    description: 'Create structured plans.',
    scope: 'plugin',
    pluginName: 'compound-engineering',
    path: '/plugin/ce-plan/SKILL.md',
}

describe('SkillPickerDialog', () => {
    afterEach(() => {
        cleanup()
    })

    beforeEach(() => {
        vi.clearAllMocks()
        localStorage.clear()
        Element.prototype.scrollIntoView = vi.fn()
        window.requestAnimationFrame = (callback: FrameRequestCallback) => {
            callback(0)
            return 0
        }
    })

    it('loads suggestions from the initial query', async () => {
        const refreshSkills = vi.fn(async () => [reviewSkill, planSkill])

        render(
            <SkillPickerDialog
                open={true}
                initialQuery="pla"
                skills={[]}
                refreshSkills={refreshSkills}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />
        )

        expect(screen.getByPlaceholderText('Search skills')).toHaveValue('pla')
        expect(await screen.findByText('$compound-engineering:ce-plan')).toBeInTheDocument()
        expect(refreshSkills).toHaveBeenCalled()
    })

    it('refines results when the search query changes', async () => {
        render(
            <SkillPickerDialog
                open={true}
                initialQuery="pla"
                skills={[reviewSkill, planSkill]}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />
        )

        fireEvent.change(screen.getByPlaceholderText('Search skills'), { target: { value: 'work' } })

        await waitFor(() => expect(screen.queryByText('$compound-engineering:ce-plan')).not.toBeInTheDocument())
        expect(screen.queryByText('$review')).not.toBeInTheDocument()
        expect(screen.getByText('No matching skills')).toBeInTheDocument()
    })

    it('defaults empty query opens to Recent with an empty state', async () => {
        render(
            <SkillPickerDialog
                open={true}
                initialQuery=""
                skills={[reviewSkill, planSkill]}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />
        )

        expect(screen.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true')
        expect(screen.getByText('No recent skills')).toBeInTheDocument()
    })

    it('shows recent skills on the Recent tab', async () => {
        markSkillUsed(skillToSearchResult(planSkill))

        render(
            <SkillPickerDialog
                open={true}
                initialQuery=""
                skills={[reviewSkill, planSkill]}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />
        )

        expect(screen.getByRole('tab', { name: 'Recent' })).toHaveAttribute('aria-selected', 'true')
        expect(await screen.findByText('$compound-engineering:ce-plan')).toBeInTheDocument()
        expect(screen.queryByText('$review')).not.toBeInTheDocument()
    })

    it('switches to All when the search query changes', async () => {
        markSkillUsed(skillToSearchResult(reviewSkill))

        render(
            <SkillPickerDialog
                open={true}
                initialQuery=""
                skills={[reviewSkill, planSkill]}
                onSelect={vi.fn()}
                onClose={vi.fn()}
            />
        )

        fireEvent.change(screen.getByPlaceholderText('Search skills'), { target: { value: 'pla' } })

        expect(screen.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true')
        expect(await screen.findByText('$compound-engineering:ce-plan')).toBeInTheDocument()
        expect(screen.queryByText('$review')).not.toBeInTheDocument()
    })

    it('selects the highlighted skill with Enter', async () => {
        const onSelect = vi.fn()

        render(
            <SkillPickerDialog
                open={true}
                initialQuery=""
                skills={[reviewSkill, planSkill]}
                onSelect={onSelect}
                onClose={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('tab', { name: 'All' }))
        await screen.findByText('$review')
        fireEvent.keyDown(screen.getByPlaceholderText('Search skills'), { key: 'ArrowDown' })
        fireEvent.keyDown(screen.getByPlaceholderText('Search skills'), { key: 'Enter' })

        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
            text: '$compound-engineering:ce-plan',
        }))
    })

    it('selects the highlighted skill with Tab', async () => {
        const onSelect = vi.fn()

        render(
            <SkillPickerDialog
                open={true}
                initialQuery=""
                skills={[reviewSkill]}
                onSelect={onSelect}
                onClose={vi.fn()}
            />
        )

        fireEvent.click(screen.getByRole('tab', { name: 'All' }))
        await screen.findByText('$review')
        fireEvent.keyDown(screen.getByPlaceholderText('Search skills'), { key: 'Tab' })

        expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({
            text: '$review',
        }))
    })

    it('closes without selecting on Escape', async () => {
        const onClose = vi.fn()
        const onSelect = vi.fn()

        render(
            <SkillPickerDialog
                open={true}
                initialQuery=""
                skills={[reviewSkill]}
                onSelect={onSelect}
                onClose={onClose}
            />
        )

        fireEvent.click(screen.getByRole('tab', { name: 'All' }))
        await screen.findByText('$review')
        fireEvent.keyDown(screen.getByPlaceholderText('Search skills'), { key: 'Escape' })

        expect(onClose).toHaveBeenCalled()
        expect(onSelect).not.toHaveBeenCalled()
    })
})
