import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode, TextareaHTMLAttributes } from 'react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import type { ComposerToolbarLayout } from '@/hooks/useComposerToolbarLayout'
import { HappyComposer } from './HappyComposer'

/**
 * Focused harness for the generic model/effort value buttons and the
 * settings-sheet section order. Reuses the assistant-ui mock strategy from
 * HappyComposer.sendError.test.tsx but keeps ComposerButtons unmocked so the
 * new value buttons are exercised for real.
 */
type FakeAttachment = { id: string; status: { type: 'complete' } }
type MockComposerInputProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    asChild?: boolean
    maxRows?: number
    submitOnEnter?: boolean
    cancelOnEscape?: boolean
}
type FakeRuntimeState = {
    composer: { text: string; attachments: FakeAttachment[] }
    thread: { isRunning: boolean; isDisabled: boolean }
}

const runtime = vi.hoisted(() => ({
    snapshot: {
        composer: { text: '', attachments: [] as FakeAttachment[] },
        thread: { isRunning: false, isDisabled: false },
    } as FakeRuntimeState,
    setSnapshot: null as null | ((updater: (current: FakeRuntimeState) => FakeRuntimeState) => void),
    pendingSendIntentRef: { current: 'default' },
    sentIntents: [] as ComposerSendIntent[],
    narrowViewport: false,
    toolbarLayout: null as ComposerToolbarLayout | null,
}))

vi.mock('@assistant-ui/react', async () => {
    const React = await import('react')
    return {
        useAui: () => ({
            composer: () => ({
                setText: (text: string) => {
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { ...current.composer, text },
                    }))
                },
                send: () => {
                    const intent = runtime.pendingSendIntentRef?.current ?? 'default'
                    runtime.sentIntents.push(intent as ComposerSendIntent)
                    if (runtime.pendingSendIntentRef) runtime.pendingSendIntentRef.current = 'default'
                    runtime.setSnapshot!((current) => ({
                        ...current,
                        composer: { text: '', attachments: [] },
                    }))
                },
                addAttachment: async () => {},
            }),
            thread: () => ({ cancelRun: () => {} }),
        }),
        useAuiState: (selector: (state: typeof runtime.snapshot) => unknown) => selector(runtime.snapshot),
        ComposerPrimitive: {
            Root: ({ children, onSubmit }: { children: ReactNode; onSubmit?: () => void }) => (
                <form onSubmit={onSubmit}>{children}</form>
            ),
            AddAttachment: ({ children }: { children: ReactNode }) => <>{children}</>,
            Input: React.forwardRef<HTMLTextAreaElement, MockComposerInputProps>(
                ({
                    asChild: _asChild,
                    onChange,
                    maxRows: _maxRows,
                    submitOnEnter: _submitOnEnter,
                    cancelOnEscape: _cancelOnEscape,
                    ...props
                }, ref) => (
                    <textarea
                        {...props}
                        ref={ref}
                        value={runtime.snapshot.composer.text}
                        onChange={(event) => {
                            runtime.setSnapshot!((current) => ({
                                ...current,
                                composer: { ...current.composer, text: event.target.value },
                            }))
                        }}
                    />
                ),
            ),
        },
    }
})
vi.mock('@/hooks/useComposerToolbarLayout', async () => {
    const actual = await import('@/hooks/useComposerToolbarLayout')
    return {
        ...actual,
        useComposerToolbarLayout: () => ({ layout: runtime.toolbarLayout ?? actual.DEFAULT_COMPOSER_TOOLBAR_LAYOUT }),
    }
})
vi.mock('@/hooks/useNarrowViewport', () => ({
    useNarrowViewport: () => runtime.narrowViewport,
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({ sessionId: undefined, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
vi.mock('@/hooks/useComposerEnterBehavior', () => ({ useComposerEnterBehavior: () => ({ composerEnterBehavior: 'send' }) }))
vi.mock('@/hooks/usePlatform', () => ({ usePlatform: () => ({ haptic: { impact: () => {}, notification: () => {} }, isTouch: false }) }))
vi.mock('@/hooks/usePWAInstall', () => ({ usePWAInstall: () => ({ isStandalone: false, isIOS: false }) }))
vi.mock('@/hooks/useActiveWord', () => ({ useActiveWord: () => null }))
vi.mock('@/hooks/useActiveSuggestions', () => ({ useActiveSuggestions: () => [[], -1, () => {}, () => {}, () => {}] }))
vi.mock('@/components/ChatInput/FloatingOverlay', () => ({ FloatingOverlay: ({ children }: { children: ReactNode }) => <>{children}</> }))
vi.mock('@/components/ChatInput/Autocomplete', () => ({ Autocomplete: () => null }))
vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))

function renderComposer(agentFlavor: string, overrides: Partial<Parameters<typeof HappyComposer>[0]> = {}) {
    render(
        <I18nProvider>
            <HappyComposer
                sessionId="composer-test"
                disabled={false}
                agentFlavor={agentFlavor}
                model="claude-sonnet-4"
                effort="high"
                permissionMode="default"
                onModelChange={vi.fn()}
                onEffortChange={vi.fn()}
                onPermissionModeChange={vi.fn()}
                availableModelOptions={[{ value: 'claude-sonnet-4', label: 'Sonnet 4' }]}
                pendingSendIntentRef={runtime.pendingSendIntentRef as { current: ComposerSendIntent }}
                {...overrides}
            />
        </I18nProvider>
    )
}

describe('HappyComposer generic model/effort value buttons', () => {
    afterEach(() => {
        cleanup()
        runtime.setSnapshot = null
        runtime.narrowViewport = false
        runtime.toolbarLayout = null
        runtime.snapshot.thread.isDisabled = false
        runtime.sentIntents = []
    })

    it('shows model and effort value buttons for Claude on wide viewports', () => {
        renderComposer('claude')
        expect(screen.getByRole('button', { name: 'Sonnet 4' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'High' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    })

    it('shows only the model button for flavors without effort support', () => {
        renderComposer('codex')
        expect(screen.getByRole('button', { name: 'Sonnet 4' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
    })

    it('hides value buttons on narrow viewports, keeping settings', () => {
        runtime.narrowViewport = true
        renderComposer('claude')
        expect(screen.queryByRole('button', { name: 'Sonnet 4' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    })

    it('opens the settings sheet from the model button with Model before Permission', () => {
        renderComposer('claude')
        fireEvent.click(screen.getByRole('button', { name: 'Sonnet 4' }))
        const model = screen.getByText('Model')
        const permission = screen.getByText('Permission Mode')
        expect(model.compareDocumentPosition(permission) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(screen.getByText('Effort')).toBeTruthy()
    })

    it('shows generic value buttons for Pi with the provider-qualified model label', () => {
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
                { provider: 'vertex', modelId: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
        })
        // Pi uses the same value buttons as every other flavor.
        expect(screen.getByRole('button', { name: 'Gemini 2.5 Pro' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'High' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    })

    it('opens the settings sheet with provider-grouped model rows for Pi', () => {
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
                { provider: 'vertex', modelId: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Gemini 2.5 Pro' }))
        expect(screen.getByText('Model')).toBeTruthy()
        // The value button label and the matching sheet row share the model name.
        expect(screen.getAllByText('Gemini 2.5 Pro').length).toBeGreaterThan(1)
        expect(screen.getByText('Vertex Gemini 2.5 Pro')).toBeTruthy()
        expect(screen.getByText('Effort')).toBeTruthy()
    })

    it('keeps the gear reachable on narrow viewports even when the toolbar layout hides it', () => {
        runtime.narrowViewport = true
        runtime.toolbarLayout = {
            mode: 'left',
            left: ['attachment', 'expand', 'terminal'],
            right: [],
            hidden: ['settings', 'abort'],
        }
        renderComposer('claude')
        // Narrow mode collapses the value buttons into the settings sheet, so the
        // gear must stay visible regardless of the persisted layout.
        expect(screen.queryByRole('button', { name: 'Sonnet 4' })).toBeNull()
        expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    })

    it('keeps the Pi settings gear live mid-turn on narrow viewports', () => {
        runtime.narrowViewport = true
        runtime.snapshot.thread.isDisabled = true
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
        })
        // Value buttons are collapsed on narrow; the gear is the only trigger and
        // must stay clickable while a Pi turn is running (#1442).
        const gear = screen.getByRole('button', { name: 'Settings' })
        expect(gear).not.toBeDisabled()
        fireEvent.click(gear)
        expect(screen.getByText('Model')).toBeTruthy()
        expect(screen.getByText('Gemini 2.5 Pro')).toBeTruthy()
    })

    it('highlights only the matching provider row when model IDs collide across providers', () => {
        renderComposer('pi', {
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
                { provider: 'vertex', modelId: 'gemini-2.5-pro', name: 'Vertex Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'vertex', modelId: 'gemini-2.5-pro' },
        })
        fireEvent.click(screen.getByRole('button', { name: 'Vertex Gemini 2.5 Pro' }))
        const sheetRow = (name: string) => screen.getAllByText(name)
            .map((el) => el.closest('button'))
            .find((btn) => btn?.className.includes('w-full'))!
        const geminiRow = sheetRow('Gemini 2.5 Pro')
        const vertexRow = sheetRow('Vertex Gemini 2.5 Pro')
        const selectedClass = 'text-[var(--app-link)]'
        expect(geminiRow.querySelector('span')!.className).not.toContain(selectedClass)
        expect(vertexRow.querySelector('span')!.className).toContain(selectedClass)
    })

    it('does not show provider-less model rows when the Pi catalog is empty', () => {
        renderComposer('pi', {
            model: 'gemini-2.5-pro',
            piModels: [],
            piSelectedModel: null,
        })
        // Without a resolved catalog there are no model or effort settings at
        // all: the gear is hidden and no provider-less fallback rows can be
        // reached (selecting one would post a bare model id the Pi runner
        // cannot resolve to a provider).
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
        expect(screen.queryByText('Model')).toBeNull()
        expect(screen.queryByText('Default')).toBeNull()
    })

    it('clears Cursor variant drill-down when the sheet is closed through the value button', () => {
        renderComposer('cursor', {
            model: 'composer-2.5-fast',
            selectedModelBase: 'composer-2.5',
            availableModelOptions: [
                { value: 'composer-2.5', label: 'Composer 2.5' },
                { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
                { value: 'composer-2.5-mini', label: 'Composer 2.5 Mini' },
            ],
            resolveModelVariantsForBase: (base) => base === 'composer-2.5'
                ? [
                    { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
                    { value: 'composer-2.5-mini', label: 'Composer 2.5 Mini' },
                ]
                : [],
        })
        // Open from the value button (label resolves to the selected base).
        const valueButton = screen.getByRole('button', { name: 'Composer 2.5' })
        fireEvent.click(valueButton)
        // Drill into the multi-variant base row: the Model section is replaced
        // by the variant sub-list with a back control.
        const baseRow = screen.getAllByRole('button', { name: 'Composer 2.5' })
            .find((btn) => btn.className.includes('w-full'))!
        fireEvent.click(baseRow)
        expect(screen.queryByText('Model')).toBeNull()
        expect(screen.getByText('← Models')).toBeTruthy()
        // Close and reopen through the value button: drill-down must reset to
        // the base model list (same behavior as the gear toggle).
        fireEvent.click(valueButton)
        fireEvent.click(valueButton)
        expect(screen.queryByText('← Models')).toBeNull()
        expect(screen.getByText('Model')).toBeTruthy()
    })

    it('exposes no effort action while the Pi catalog is unresolved mid-turn', () => {
        runtime.snapshot.thread.isDisabled = true
        renderComposer('pi', {
            model: 'gemini-2.5-pro',
            piModels: [],
            piSelectedModel: null,
        })
        // With no resolved catalog entry there is no capability map, so no
        // effort value button and no gear that could open an effort sheet
        // (the old dedicated control was disabled in this state too). The
        // model value button must not render either: a bare session id has no
        // provider and the sheet has no Model section to open.
        expect(screen.queryByRole('button', { name: 'gemini-2.5-pro' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'High' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull()
    })

    it('clears the Pi thinking level when the selected effort row is clicked again', () => {
        const effortChanges: Array<string | null> = []
        renderComposer('pi', {
            effort: 'high',
            piModels: [
                { provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true },
            ],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
            onEffortChange: (level) => effortChanges.push(level),
        })
        // Open the sheet from the 'High' value button, then re-click the 'High' row.
        fireEvent.click(screen.getByRole('button', { name: 'High' }))
        const effortRows = screen.getAllByRole('button', { name: 'High' })
        expect(effortRows.length).toBeGreaterThan(1)
        // The sheet renders before the toolbar in the DOM, so the first match is the row.
        fireEvent.click(effortRows[0])
        expect(effortChanges).toEqual([null])
    })

    it('re-evaluates the Pi sheet row disabled state when configuration controls change', () => {
        const common = {
            sessionId: 'composer-test',
            disabled: false,
            agentFlavor: 'pi' as const,
            model: 'gemini-2.5-pro',
            effort: 'high' as const,
            permissionMode: 'default' as const,
            onModelChange: vi.fn(),
            onEffortChange: vi.fn(),
            onPermissionModeChange: vi.fn(),
            piModels: [{ provider: 'gemini', modelId: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true }],
            piSelectedModel: { provider: 'gemini', modelId: 'gemini-2.5-pro' },
            pendingSendIntentRef: runtime.pendingSendIntentRef as { current: ComposerSendIntent },
        }
        const { rerender } = render(
            <I18nProvider>
                <HappyComposer {...common} active={true} />
            </I18nProvider>
        )
        // Open the sheet while controls are live.
        fireEvent.click(screen.getByRole('button', { name: 'Gemini 2.5 Pro' }))
        const sheetRow = () => screen.getAllByRole('button', { name: 'Gemini 2.5 Pro' })
            .find((btn) => btn.className.includes('w-full'))!
        expect(sheetRow()).not.toBeDisabled()
        // Inactive session disables configuration controls; the sheet rows must follow.
        rerender(
            <I18nProvider>
                <HappyComposer {...common} active={false} />
            </I18nProvider>
        )
        expect(sheetRow()).toBeDisabled()
    })

    it('maps the default selection (model=null) onto the localized default option label', () => {
        renderComposer('claude', { model: null })
        expect(screen.getByRole('button', { name: 'Default' })).toBeTruthy()
        expect(screen.queryByRole('button', { name: 'Sonnet 4' })).toBeNull()
    })

    it('maps auto/default wire values onto the localized default option label', () => {
        renderComposer('claude', { model: 'auto' })
        expect(screen.getByRole('button', { name: 'Default' })).toBeTruthy()
    })

    it('toggles the settings sheet closed when the model value button is clicked again', () => {
        renderComposer('claude')
        const modelButton = screen.getAllByRole('button', { name: 'Sonnet 4' })[0]
        fireEvent.click(modelButton)
        expect(screen.getByText('Model')).toBeTruthy()
        fireEvent.click(modelButton)
        expect(screen.queryByText('Model')).toBeNull()
    })

    it('toggles the settings sheet closed when the effort value button is clicked again', () => {
        renderComposer('claude')
        const effortButton = screen.getAllByRole('button', { name: 'High' })[0]
        fireEvent.click(effortButton)
        expect(screen.getByText('Effort')).toBeTruthy()
        fireEvent.click(effortButton)
        expect(screen.queryByText('Effort')).toBeNull()
    })
})
