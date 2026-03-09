import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { ChecklistList, extractTodoChecklist, extractUpdatePlanChecklist } from '@/components/ToolCard/checklist'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { getToolViewComponent } from '@/components/ToolCard/views/_all'
import { UpdatePlanView } from '@/components/ToolCard/views/UpdatePlanView'

function makeUpdatePlanBlock(input: unknown, result?: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 0,
        tool: {
            id: 'tool-1',
            name: 'update_plan',
            state: 'completed',
            input,
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            description: null,
            result
        },
        children: []
    }
}

describe('extractUpdatePlanChecklist', () => {
    it('prefers input.plan over result.plan', () => {
        const items = extractUpdatePlanChecklist(
            {
                plan: [
                    { step: 'Patch root cause', status: 'completed' }
                ]
            },
            {
                plan: [
                    { step: 'Result fallback', status: 'pending' }
                ]
            }
        )

        expect(items).toEqual([
            { text: 'Patch root cause', status: 'completed', id: undefined }
        ])
    })

    it('falls back to result.plan when input.plan is absent', () => {
        const items = extractUpdatePlanChecklist(
            {},
            {
                plan: [
                    { step: 'Re-run build validation', status: 'in_progress' }
                ]
            }
        )

        expect(items).toEqual([
            { text: 'Re-run build validation', status: 'in_progress', id: undefined }
        ])
    })

    it('keeps valid steps and normalizes unknown status to pending', () => {
        const items = extractUpdatePlanChecklist(
            {
                plan: [
                    { step: 'Summarize fix', status: 'unknown_status' },
                    { step: 123, status: 'completed' },
                    { status: 'pending' }
                ]
            },
            null
        )

        expect(items).toEqual([
            { text: 'Summarize fix', status: 'pending', id: undefined }
        ])
    })
})

describe('extractTodoChecklist', () => {
    it('uses result.newTodos when input.todos is unavailable', () => {
        const items = extractTodoChecklist(
            null,
            {
                newTodos: [
                    { id: 'todo-1', content: 'Ship it', status: 'completed' }
                ]
            }
        )

        expect(items).toEqual([
            { id: 'todo-1', text: 'Ship it', status: 'completed' }
        ])
    })
})

describe('update_plan tool presentation', () => {
    it('shows plan title, step count, and expanded body when steps exist', () => {
        const presentation = getToolPresentation({
            toolName: 'update_plan',
            input: {
                plan: [
                    { step: 'Reproduce web build failure', status: 'completed' },
                    { step: 'Trace broken build path', status: 'completed' }
                ]
            },
            result: undefined,
            childrenCount: 0,
            description: null,
            metadata: null
        })

        expect(presentation.title).toBe('Plan')
        expect(presentation.subtitle).toBe('2 steps')
        expect(presentation.minimal).toBe(false)
    })

    it('stays minimal when there are no valid steps', () => {
        const presentation = getToolPresentation({
            toolName: 'update_plan',
            input: { plan: [{ status: 'completed' }] },
            result: undefined,
            childrenCount: 0,
            description: null,
            metadata: null
        })

        expect(presentation.subtitle).toBeNull()
        expect(presentation.minimal).toBe(true)
    })
})

describe('UpdatePlanView', () => {
    it('renders checklist rows with status styling', () => {
        render(
            <UpdatePlanView
                block={makeUpdatePlanBlock({
                    plan: [
                        { step: 'Reproduce web build failure', status: 'completed' },
                        { step: 'Trace broken build path', status: 'in_progress' },
                        { step: 'Summarize fix', status: 'unknown_status' }
                    ]
                })}
                metadata={null}
            />
        )

        const completed = screen.getByText(/Reproduce web build failure/)
        const inProgress = screen.getByText(/Trace broken build path/)
        const pending = screen.getByText(/Summarize fix/)

        expect(completed).toBeInTheDocument()
        expect(completed.className).toContain('line-through')
        expect(inProgress.className).toContain('text-[var(--app-link)]')
        expect(pending.className).toContain('text-[var(--app-hint)]')
    })

    it('is registered as the compact tool view', () => {
        expect(getToolViewComponent('update_plan')).toBe(UpdatePlanView)
    })
})

describe('ChecklistList', () => {
    it('renders blank steps as empty placeholders', () => {
        render(
            <ChecklistList
                items={[
                    { text: '   ', status: 'pending' }
                ]}
            />
        )

        expect(screen.getByText(/\(empty\)/)).toBeInTheDocument()
    })
})
