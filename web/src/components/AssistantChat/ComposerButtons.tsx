import { ComposerPrimitive } from '@assistant-ui/react'
import type { PermissionMode } from '@/types/api'
import type { ConversationStatus } from '@/realtime/types'
import { useTranslation } from '@/lib/use-translation'
import { ScheduleIcon } from '@/components/icons'
import { ScheduleTimePicker } from './ScheduleTimePicker'
import type { PendingSchedule } from './ScheduleTimePicker'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

function ChevronIcon() {
    return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 3.75L5 6.25L7.5 3.75" /></svg>
}

function PlusIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 5v14M5 12h14" />
        </svg>
    )
}

function VoiceAssistantIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {/* 三条声波线，代表语音助手的输出 */}
            <path d="M12 6v12" />
            <path d="M8 9v6" />
            <path d="M16 9v6" />
            <path d="M4 11v2" />
            <path d="M20 11v2" />
        </svg>
    )
}

function SpeakerIcon(props: { muted?: boolean }) {
    if (props.muted) {
        // Speaker with X (muted)
        return (
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="22" y1="9" x2="16" y2="15" />
                <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
        )
    }

    // Speaker with sound waves
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
    )
}

function SwitchToRemoteIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
    )
}

function TerminalIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
            <polyline points="7 9 10 12 7 15" />
            <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
    )
}

function AttachmentIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
        </svg>
    )
}

function PlanModeIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M8 6h13M8 12h13M8 18h13" />
            <path d="M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
    )
}

function GoalModeIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="12" cy="12" r="8" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    )
}

function AbortIcon(props: { spinning: boolean }) {
    if (props.spinning) {
        return (
            <svg
                className="animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            >
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
            </svg>
        )
    }

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="currentColor"
        >
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4-2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1-.5-.5v-4Z" />
        </svg>
    )
}

function SendIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
        </svg>
    )
}

function ScratchlistToggleIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3.5 2.5h6L12.5 5.5v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
            <path d="M9.5 2.5v3h3M5 8.5h6M5 11h4" />
        </svg>
    )
}

function StopIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
    )
}

function LoadingIcon() {
    return (
        <svg
            className="animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
        >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
        </svg>
    )
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max)
}

function ToolbarMenu(props: {
    anchorRef: RefObject<HTMLElement | null>
    align?: 'left' | 'right'
    width?: number
    maxHeight?: number
    onClose: () => void
    children: ReactNode
}) {
    const panelRef = useRef<HTMLDivElement>(null)
    const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null)

    useLayoutEffect(() => {
        function measure() {
            const anchor = props.anchorRef.current
            if (!anchor) return
            const panel = panelRef.current
            const viewport = window.visualViewport
            const viewportLeft = viewport?.offsetLeft ?? 0
            const viewportTop = viewport?.offsetTop ?? 0
            const viewportWidth = viewport?.width ?? window.innerWidth
            const viewportHeight = viewport?.height ?? window.innerHeight
            const margin = 8
            const gap = 8
            const panelWidth = props.width ?? panel?.offsetWidth ?? 220
            const fullHeight = Math.min(panel?.scrollHeight ?? props.maxHeight ?? 260, props.maxHeight ?? 260)
            const rect = anchor.getBoundingClientRect()
            const minLeft = viewportLeft + margin
            const maxLeft = viewportLeft + viewportWidth - panelWidth - margin
            const preferredLeft = props.align === 'right' ? rect.right - panelWidth : rect.left
            const left = clamp(preferredLeft, minLeft, Math.max(minLeft, maxLeft))
            const aboveTop = rect.top - gap - fullHeight
            const belowTop = rect.bottom + gap
            const top = aboveTop >= viewportTop + margin
                ? aboveTop
                : clamp(belowTop, viewportTop + margin, viewportTop + viewportHeight - margin - fullHeight)
            const maxHeight = Math.max(120, Math.min(fullHeight, viewportTop + viewportHeight - margin - top))
            setPosition({ top, left, maxHeight })
        }

        measure()
        window.addEventListener('resize', measure, { passive: true })
        window.addEventListener('scroll', measure, { passive: true, capture: true })
        window.visualViewport?.addEventListener('resize', measure, { passive: true })
        window.visualViewport?.addEventListener('scroll', measure, { passive: true })
        return () => {
            window.removeEventListener('resize', measure)
            window.removeEventListener('scroll', measure, true)
            window.visualViewport?.removeEventListener('resize', measure)
            window.visualViewport?.removeEventListener('scroll', measure)
        }
    }, [props.anchorRef, props.align, props.width, props.maxHeight])

    useEffect(() => {
        function handlePointerDown(event: PointerEvent) {
            const target = event.target as Node
            if (panelRef.current?.contains(target)) return
            if (props.anchorRef.current?.contains(target)) return
            props.onClose()
        }
        document.addEventListener('pointerdown', handlePointerDown)
        return () => document.removeEventListener('pointerdown', handlePointerDown)
    }, [props.anchorRef, props.onClose])

    return (
        <div
            ref={panelRef}
            style={position
                ? { position: 'fixed', top: position.top, left: position.left, width: props.width ?? 220, maxHeight: position.maxHeight }
                : { position: 'fixed', visibility: 'hidden', width: props.width ?? 220 }
            }
            className="z-50 overflow-hidden rounded-xl border border-[var(--app-divider)] bg-[var(--app-bg)] shadow-lg"
            onPointerDown={(event) => event.stopPropagation()}
        >
            <div className="overflow-y-auto" style={{ maxHeight: position?.maxHeight ?? props.maxHeight ?? 260 }}>
                {props.children}
            </div>
        </div>
    )
}

function ContextUsageIndicator(props: { percentage: number | null | undefined; label?: string }) {
    if (props.percentage == null) return null

    const percentage = Math.min(100, Math.max(0, props.percentage))
    const radius = 6
    const circumference = 2 * Math.PI * radius
    const shade = Math.round(185 - percentage * 1.25)
    const progressColor = `rgb(${shade}, ${shade}, ${shade})`

    return (
        <span
            className="flex h-8 w-5 shrink-0 items-center justify-center"
            aria-label={props.label}
            title={props.label}
        >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r={radius} fill="none" stroke="rgb(229, 231, 235)" strokeWidth="2" />
                <circle
                    cx="8"
                    cy="8"
                    r={radius}
                    fill="none"
                    stroke={progressColor}
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - percentage / 100)}
                    transform="rotate(-90 8 8)"
                />
            </svg>
        </span>
    )
}

export function UnifiedButton(props: {
    canSend: boolean
    voiceStatus: ConversationStatus
    voiceEnabled: boolean
    controlsDisabled: boolean
    onSend: () => void
    onVoiceToggle: () => void
    /**
     * When true, the send button repaints amber and the aria-label
     * announces "Send to scratchlist" instead of "Send message". The
     * actual routing happens in SessionChat's wrapped onSend - the
     * button itself is content-agnostic.
     *
     * Caller MUST compute this from the actual routing decision (mode
     * AND no-attachments AND no-pending-schedule), not the raw
     * scratchlist toggle. If the toggle is on but the submission would
     * fall back to chat (because the scratchlist can't represent the
     * payload), the button must look like a normal chat send. Per
     * upstream review on PR #798: [Major] "Send button advertises
     * scratchlist routing even when the submit will go to chat".
     */
    routesToScratchlist?: boolean
}) {
    const { t } = useTranslation()

    const isConnecting = props.voiceStatus === 'connecting'
    const isConnected = props.voiceStatus === 'connected'
    const isVoiceActive = isConnecting || isConnected
    const hasText = props.canSend
    const routesToScratchlist = props.routesToScratchlist ?? false

    const handleClick = () => {
        if (isVoiceActive) {
            props.onVoiceToggle() // Stop voice
        } else if (hasText) {
            props.onSend() // Send message (or scratchlist add — wrapper decides)
        } else if (props.voiceEnabled && !routesToScratchlist) {
            props.onVoiceToggle() // Start voice (suppressed in scratchlist mode)
        }
    }

    let icon: ReactNode
    let className: string
    let ariaLabel: string

    if (isConnecting) {
        icon = <LoadingIcon />
        className = 'bg-black text-white'
        ariaLabel = t('voice.connecting')
    } else if (isConnected) {
        icon = <StopIcon />
        className = 'bg-black text-white'
        ariaLabel = t('composer.stop')
    } else if (routesToScratchlist) {
        // Amber send button - matches the scratchlist drawer accent.
        // Single visual signal carries the "this goes to the scratchlist"
        // contract; without it, the modal state is invisible to the user.
        icon = <SendIcon />
        className = 'bg-amber-500 text-white hover:bg-amber-600'
        ariaLabel = t('scratchlist.sendToScratchlist')
    } else if (hasText) {
        icon = <SendIcon />
        className = 'bg-black text-white'
        ariaLabel = t('composer.send')
    } else if (props.voiceEnabled) {
        icon = <VoiceAssistantIcon />
        className = 'bg-black text-white'
        ariaLabel = t('composer.voice')
    } else {
        icon = <SendIcon />
        className = 'bg-[#C0C0C0] text-white'
        ariaLabel = t('composer.send')
    }

    // When the submission routes to scratchlist the send button is the
    // only path that does anything useful, so it must be enabled whenever
    // there is text - we deliberately do NOT fall back to voice-toggle-on-
    // empty-text. (When attachments / schedule force a chat fallback the
    // normal chat-send disable rules apply.)
    const isDisabled = props.controlsDisabled || (
        routesToScratchlist
            ? !hasText
            : !hasText && !props.voiceEnabled && !isVoiceActive
    )

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={isDisabled}
            aria-label={ariaLabel}
            title={ariaLabel}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        >
            {icon}
        </button>
    )
}

export function ComposerButtons(props: {
    canSend: boolean
    controlsDisabled: boolean
    showSettingsButton: boolean
    onSettingsToggle: () => void
    settingsLabel?: string
    settingsModelLabel?: string
    settingsReasoningLabel?: string | null
    settingsOpen?: boolean
    contextUsagePercent?: number | null
    contextUsageLabel?: string
    permissionMode?: PermissionMode
    permissionLabel?: string
    permissionModeOptions?: Array<{ mode: PermissionMode; label: string }>
    onPermissionModeChange?: (mode: PermissionMode) => void
    showPlanModeButton?: boolean
    planModeActive?: boolean
    onPlanModeToggle?: () => void
    showGoalModeButton?: boolean
    goalModeActive?: boolean
    onGoalModeOpen?: () => void
    showTerminalButton: boolean
    terminalDisabled: boolean
    terminalLabel: string
    onTerminal: () => void
    showAbortButton: boolean
    abortDisabled: boolean
    isAborting: boolean
    onAbort: () => void
    showSwitchButton: boolean
    switchDisabled: boolean
    isSwitching: boolean
    onSwitch: () => void
    voiceEnabled: boolean
    voiceStatus: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceToggle: () => void
    onVoiceMicToggle?: () => void
    onSend: () => void
    pendingSchedule?: PendingSchedule | null
    onSchedule?: (pending: PendingSchedule) => void
    onClearSchedule?: () => void
    // The backend rejects scheduled-send + attachment combinations (the per-CLI
    // upload directory is torn down before a mature emit could read the files).
    // The composer must surface that constraint at UI time so the user never
    // builds a submission the hub will reject — see hub/web/routes/messages.ts.
    hasAttachments?: boolean
    // Pi-specific toolbar buttons
    piModelLabel?: string
    piModelDisabled?: boolean
    piModelOpen?: boolean
    onPiModelToggle?: () => void
    piThinkingLabel?: string
    piThinkingDisabled?: boolean
    piThinkingOpen?: boolean
    onPiThinkingToggle?: () => void
    // Scratchlist drawer toggle. When `onScratchlistToggle` is provided, a
    // notepad icon appears next to the schedule-send icon. Click toggles
    // composer-send-routing between chat and scratchlist; SessionChat owns
    // the actual routing decision via its wrapped onSend.
    scratchlistMode?: boolean
    scratchlistCount?: number
    onScratchlistToggle?: () => void
}) {
    const { t } = useTranslation()
    const isVoiceConnected = props.voiceStatus === 'connected'
    const [showSchedulePicker, setShowSchedulePicker] = useState(false)
    const [showToolsMenu, setShowToolsMenu] = useState(false)
    const [showPermissionMenu, setShowPermissionMenu] = useState(false)
    const toolsButtonRef = useRef<HTMLButtonElement>(null)
    const permissionButtonRef = useRef<HTMLButtonElement>(null)

    const hasSchedule = props.pendingSchedule != null
    const hasAttachments = props.hasAttachments ?? false
    const showPermissionButton = Boolean(props.onPermissionModeChange && props.permissionModeOptions?.length)
    const permissionLabel = props.permissionLabel
        ?? props.permissionModeOptions?.find((option) => option.mode === props.permissionMode)?.label
        ?? props.permissionMode
        ?? t('misc.permissionMode')
    const isYoloPermission = (mode: PermissionMode | undefined) => (
        mode === 'bypassPermissions'
        || mode === 'safe-yolo'
        || mode === 'yolo'
    )
    const toolMenuItemClass = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)] disabled:cursor-not-allowed disabled:opacity-45'

    return (
        <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
                <button
                    ref={toolsButtonRef}
                    type="button"
                    aria-label={t('composer.moreTools')}
                    title={t('composer.moreTools')}
                    className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                        showToolsMenu
                            ? 'bg-[var(--app-bg)] text-[var(--app-fg)]'
                            : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                    }`}
                    onClick={() => {
                        setShowToolsMenu((open) => !open)
                        setShowPermissionMenu(false)
                        setShowSchedulePicker(false)
                    }}
                >
                    <PlusIcon />
                </button>

                {showPermissionButton ? (
                    <button
                        ref={permissionButtonRef}
                        type="button"
                        aria-label={t('misc.permissionMode')}
                        title={t('misc.permissionMode')}
                        disabled={props.controlsDisabled}
                        className={`flex h-8 items-center gap-1 rounded-full px-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            showPermissionMenu
                                ? isYoloPermission(props.permissionMode) ? 'bg-[var(--app-bg)] text-orange-500' : 'bg-[var(--app-bg)] text-[var(--app-fg)]'
                                : isYoloPermission(props.permissionMode) ? 'text-orange-500 hover:bg-[var(--app-bg)] hover:text-orange-600' : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={() => {
                            setShowPermissionMenu((open) => !open)
                            setShowToolsMenu(false)
                            setShowSchedulePicker(false)
                        }}
                    >
                        <span className="max-w-28 truncate">{permissionLabel}</span>
                        <ChevronIcon />
                    </button>
                ) : null}

                {showToolsMenu ? (
                    <ToolbarMenu
                        anchorRef={toolsButtonRef}
                        align="left"
                        width={220}
                        maxHeight={280}
                        onClose={() => setShowToolsMenu(false)}
                    >
                        <div className="py-1">
                            {props.showPlanModeButton && props.onPlanModeToggle ? (
                                <button
                                    type="button"
                                    aria-label={t('composer.planMode')}
                                    title={t('composer.planMode')}
                                    disabled={props.controlsDisabled}
                                    onClick={() => {
                                        setShowToolsMenu(false)
                                        props.onPlanModeToggle?.()
                                    }}
                                    className={toolMenuItemClass}
                                >
                                    <PlanModeIcon />
                                    <span className="flex-1">{t('composer.planMode')}</span>
                                    {props.planModeActive ? <span className="text-[var(--app-hint)]">✓</span> : null}
                                </button>
                            ) : null}

                            {props.showGoalModeButton && props.onGoalModeOpen ? (
                                <button
                                    type="button"
                                    aria-label={t('composer.goalMode')}
                                    title={t('composer.goalMode')}
                                    disabled={props.controlsDisabled}
                                    onClick={() => {
                                        setShowToolsMenu(false)
                                        props.onGoalModeOpen?.()
                                    }}
                                    className={toolMenuItemClass}
                                >
                                    <GoalModeIcon />
                                    <span className="flex-1">{t('composer.goalMode')}</span>
                                    {props.goalModeActive ? <span className="text-[var(--app-hint)]">✓</span> : null}
                                </button>
                            ) : null}

                            {(props.showPlanModeButton || props.showGoalModeButton) ? (
                                <div className="my-1 h-px bg-[var(--app-divider)]" />
                            ) : null}

                            <ComposerPrimitive.AddAttachment
                                aria-label={t('composer.attach')}
                                title={t('composer.attach')}
                                disabled={props.controlsDisabled || hasSchedule}
                                onClick={() => setShowToolsMenu(false)}
                                className={toolMenuItemClass}
                            >
                                <AttachmentIcon />
                                <span className="flex-1">{t('composer.attach')}</span>
                            </ComposerPrimitive.AddAttachment>

                            {props.showTerminalButton ? (
                                <button
                                    type="button"
                                    aria-label={props.terminalLabel}
                                    title={props.terminalLabel}
                                    className={toolMenuItemClass}
                                    onClick={() => {
                                        setShowToolsMenu(false)
                                        props.onTerminal()
                                    }}
                                    disabled={props.terminalDisabled}
                                >
                                    <TerminalIcon />
                                    <span className="flex-1">{props.terminalLabel}</span>
                                </button>
                            ) : null}

                            {props.onSchedule ? (
                                <button
                                    type="button"
                                    aria-label={t('composer.scheduleSend')}
                                    title={t('composer.scheduleSend')}
                                    disabled={props.controlsDisabled || hasAttachments}
                                    onClick={() => {
                                        setShowToolsMenu(false)
                                        if (hasSchedule && props.onClearSchedule) {
                                            props.onClearSchedule()
                                            return
                                        }
                                        setShowSchedulePicker(true)
                                    }}
                                    className={toolMenuItemClass}
                                >
                                    <ScheduleIcon className="h-[18px] w-[18px]" />
                                    <span className="flex-1">{t('composer.scheduleSend')}</span>
                                    {hasSchedule ? <span className="text-[var(--app-hint)]">✓</span> : null}
                                </button>
                            ) : null}

                            {props.onScratchlistToggle ? (
                                <button
                                    type="button"
                                    aria-label={t('scratchlist.toggleAriaLabel')}
                                    title={t('scratchlist.toggleTooltip')}
                                    aria-pressed={props.scratchlistMode ? true : false}
                                    disabled={props.controlsDisabled}
                                    onClick={() => {
                                        setShowToolsMenu(false)
                                        props.onScratchlistToggle?.()
                                    }}
                                    className={toolMenuItemClass}
                                >
                                    <ScratchlistToggleIcon />
                                    <span className="flex-1">{t('scratchlist.title')}</span>
                                    {props.scratchlistMode ? <span className="text-amber-500">✓</span> : null}
                                    {!props.scratchlistMode && (props.scratchlistCount ?? 0) > 0 ? (
                                        <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
                                            {(props.scratchlistCount ?? 0) > 99 ? '99+' : props.scratchlistCount}
                                        </span>
                                    ) : null}
                                </button>
                            ) : null}
                        </div>
                    </ToolbarMenu>
                ) : null}

                {showPermissionMenu && props.permissionModeOptions ? (
                    <ToolbarMenu
                        anchorRef={permissionButtonRef}
                        align="left"
                        width={190}
                        maxHeight={280}
                        onClose={() => setShowPermissionMenu(false)}
                    >
                        <div className="py-1">
                            {props.permissionModeOptions.map((option) => {
                                const selected = option.mode === props.permissionMode
                                const yoloOption = isYoloPermission(option.mode)
                                return (
                                    <button
                                        key={option.mode}
                                        type="button"
                                        disabled={props.controlsDisabled}
                                        className={toolMenuItemClass}
                                        onClick={() => {
                                            props.onPermissionModeChange?.(option.mode)
                                            setShowPermissionMenu(false)
                                        }}
                                    >
                                        <span className={`flex-1 ${selected ? 'font-medium' : ''} ${yoloOption ? 'text-orange-500' : ''}`}>
                                            {option.label}
                                        </span>
                                        {selected ? <span className="text-[var(--app-hint)]">✓</span> : null}
                                    </button>
                                )
                            })}
                        </div>
                    </ToolbarMenu>
                ) : null}

                {showSchedulePicker && props.onSchedule ? (
                    <ScheduleTimePicker
                        anchorRef={toolsButtonRef}
                        onSchedule={(pending) => {
                            props.onSchedule!(pending)
                            setShowSchedulePicker(false)
                        }}
                        onClose={() => setShowSchedulePicker(false)}
                        pendingSchedule={props.pendingSchedule}
                    />
                ) : null}

                {props.piModelLabel ? (
                    <button
                        type="button"
                        aria-label={props.piModelLabel}
                        title={props.piModelLabel}
                        className={`flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors ${
                            props.piModelOpen
                                ? 'bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                                : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={props.onPiModelToggle}
                        disabled={props.piModelDisabled}
                    >
                        {props.piModelLabel}
                        <ChevronIcon />
                    </button>
                ) : null}

                {props.piThinkingLabel ? (
                    <button
                        type="button"
                        aria-label={props.piThinkingLabel}
                        title={props.piThinkingLabel}
                        className={`flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors ${
                            props.piThinkingOpen
                                ? 'bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                                : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={props.onPiThinkingToggle}
                        disabled={props.piThinkingDisabled}
                    >
                        {props.piThinkingLabel}
                        <ChevronIcon />
                    </button>
                ) : null}

                {props.showAbortButton ? (
                    <button
                        type="button"
                        aria-label={t('composer.abort')}
                        title={t('composer.abort')}
                        disabled={props.abortDisabled}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={props.onAbort}
                    >
                        <AbortIcon spinning={props.isAborting} />
                    </button>
                ) : null}

                {props.showSwitchButton ? (
                    <button
                        type="button"
                        aria-label={t('composer.switchRemote')}
                        title={t('composer.switchRemote')}
                        disabled={props.switchDisabled}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={props.onSwitch}
                    >
                        <SwitchToRemoteIcon />
                    </button>
                ) : null}
            </div>

            <div className="flex items-center gap-1">
                <ContextUsageIndicator
                    percentage={props.contextUsagePercent}
                    label={props.contextUsageLabel}
                />

                {props.showSettingsButton ? (
                    <button
                        type="button"
                        aria-label={t('composer.settings')}
                        title={t('composer.settings')}
                        className={`settings-button flex h-8 items-center gap-1.5 rounded-full px-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                            props.settingsOpen
                                ? 'bg-[var(--app-bg)] text-[var(--app-fg)]'
                                : 'text-[var(--app-fg)]/65 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={() => {
                            setShowToolsMenu(false)
                            setShowPermissionMenu(false)
                            setShowSchedulePicker(false)
                            props.onSettingsToggle()
                        }}
                        disabled={props.controlsDisabled}
                    >
                        {props.settingsModelLabel ? (
                            <>
                                <span className="whitespace-nowrap font-bold text-[var(--app-fg)]">{props.settingsModelLabel}</span>
                                {props.settingsReasoningLabel ? (
                                    <span className="whitespace-nowrap">{props.settingsReasoningLabel}</span>
                                ) : null}
                            </>
                        ) : (
                            <span className="whitespace-nowrap font-semibold">{props.settingsLabel ?? t('composer.settings')}</span>
                        )}
                        <ChevronIcon />
                    </button>
                ) : null}

                {isVoiceConnected && props.onVoiceMicToggle ? (
                    <button
                        type="button"
                        aria-label={props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}
                        title={props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}
                        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                            props.voiceMicMuted
                                ? 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                                : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                        }`}
                        onClick={props.onVoiceMicToggle}
                    >
                        <SpeakerIcon muted={props.voiceMicMuted} />
                    </button>
                ) : null}

                <UnifiedButton
                    canSend={props.canSend}
                    voiceStatus={props.voiceStatus}
                    voiceEnabled={props.voiceEnabled}
                    controlsDisabled={props.controlsDisabled}
                    onSend={props.onSend}
                    onVoiceToggle={props.onVoiceToggle}
                    /*
                     * Derived, NOT raw scratchlistMode. Mirror SessionChat's
                     * shouldRouteToScratchlist so the visible send-button state
                     * matches the actual routing decision: amber + "Send to
                     * scratchlist" only when mode is on AND the payload would
                     * be a pure-text scratchlist add. Attachments or a pending
                     * schedule force a chat fallback in onSendForComposer; the
                     * button must reflect that, otherwise the UI lies about
                     * where the user's content is going.
                     */
                    routesToScratchlist={
                        (props.scratchlistMode ?? false)
                        && !hasAttachments
                        && props.pendingSchedule == null
                    }
                />
            </div>
        </div>
    )
}
