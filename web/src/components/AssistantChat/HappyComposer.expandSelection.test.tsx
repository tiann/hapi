import {
    AssistantRuntimeProvider,
    type ChatModelAdapter,
    useLocalRuntime,
} from '@assistant-ui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Ref } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HappyComposer } from './HappyComposer'

vi.mock('@/components/AssistantChat/ComposerButtons', () => ({
    ComposerButtons: (props: {
        expanded: boolean
        onExpandedToggle: () => void
        showSettingsButton: boolean
        settingsButtonRef?: Ref<HTMLButtonElement>
        onSettingsToggle: () => void
    }) => (
        <div>
            <button
                type="button"
                aria-label={props.expanded ? 'Collapse message editor' : 'Expand message editor'}
                onClick={props.onExpandedToggle}
            />
            {props.showSettingsButton ? (
                <button
                    ref={props.settingsButtonRef}
                    type="button"
                    aria-label="Composer settings"
                    onClick={props.onSettingsToggle}
                />
            ) : null}
        </div>
    ),
}))

vi.mock('@/components/AssistantChat/StatusBar', () => ({ StatusBar: () => null }))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({ sessionId: undefined, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTelegram: false,
        isTouch: false,
        haptic: {
            impact: () => {},
            notification: () => {},
            selection: () => {},
        },
    }),
}))
vi.mock('@/hooks/usePWAInstall', () => ({
    usePWAInstall: () => ({
        installState: 'idle',
        canInstall: false,
        canInstallIOS: false,
        isStandalone: false,
        isIOS: false,
        promptInstall: async () => false,
        dismissInstall: () => {},
    }),
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key === 'misc.typeAMessage' ? 'Type a message' : key,
    }),
}))

const adapter: ChatModelAdapter = {
    async *run() {},
}

function TestRuntime(props: { withSettings?: boolean }) {
    const runtime = useLocalRuntime(adapter)
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <HappyComposer
                agentFlavor={props.withSettings ? 'claude' : undefined}
                onPermissionModeChange={props.withSettings ? () => {} : undefined}
            />
            {props.withSettings ? (
                <button
                    type="button"
                    aria-label="Outside action"
                    onPointerDown={(event) => event.stopPropagation()}
                />
            ) : null}
        </AssistantRuntimeProvider>
    )
}

describe('HappyComposer plain-text expansion', () => {
    beforeEach(() => {
        localStorage.clear()
        localStorage.setItem('hapi.composer.richMentions', '0')
    })

    it('preserves draft text and selection across expand and collapse', async () => {
        render(<TestRuntime />)

        const draft = 'A long draft with a selection in the middle that must survive both editor layout changes.'
        const collapsedInput = screen.getByRole('textbox') as HTMLTextAreaElement
        fireEvent.change(collapsedInput, { target: { value: draft } })
        collapsedInput.setSelectionRange(12, 36, 'forward')

        fireEvent.click(screen.getByRole('button', { name: 'Expand message editor' }))

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Collapse message editor' })).toBeInTheDocument()
            const expandedInput = screen.getByRole('textbox') as HTMLTextAreaElement
            expect(expandedInput).not.toBe(collapsedInput)
            expect(expandedInput.value).toBe(draft)
            expect(expandedInput.selectionStart).toBe(12)
            expect(expandedInput.selectionEnd).toBe(36)
            expect(expandedInput.selectionDirection).toBe('forward')
            expect(document.activeElement).toBe(expandedInput)
        })

        const expandedInput = screen.getByRole('textbox') as HTMLTextAreaElement
        expandedInput.setSelectionRange(42, 67, 'backward')
        fireEvent.click(screen.getByRole('button', { name: 'Collapse message editor' }))

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Expand message editor' })).toBeInTheDocument()
            const nextCollapsedInput = screen.getByRole('textbox') as HTMLTextAreaElement
            expect(nextCollapsedInput).not.toBe(expandedInput)
            expect(nextCollapsedInput.value).toBe(draft)
            expect(nextCollapsedInput.selectionStart).toBe(42)
            expect(nextCollapsedInput.selectionEnd).toBe(67)
            expect(nextCollapsedInput.selectionDirection).toBe('backward')
            expect(document.activeElement).toBe(nextCollapsedInput)
        })
    })

    it('closes settings when clicking outside while preserving inside and trigger interactions', () => {
        render(<TestRuntime withSettings />)

        const settingsButton = screen.getByRole('button', { name: 'Composer settings' })
        fireEvent.click(settingsButton)

        const panelLabel = screen.getByText('misc.permissionMode')
        fireEvent.pointerDown(panelLabel)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(screen.getByRole('textbox'))
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside action' }))
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()
    })
})
