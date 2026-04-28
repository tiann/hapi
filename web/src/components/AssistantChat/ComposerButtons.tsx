import { ComposerPrimitive } from '@assistant-ui/react'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CodexUsage } from '@hapi/protocol/types'
import type { ConversationStatus } from '@/realtime/types'
import { useTranslation } from '@/lib/use-translation'
import { getCodexUsageRingPercent, getCodexUsageRows } from './codexUsageDisplay'

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

function SettingsIcon() {
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
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
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

function UnifiedButton(props: {
    canSend: boolean
    voiceStatus: ConversationStatus
    voiceEnabled: boolean
    controlsDisabled: boolean
    onSend: () => void
    onVoiceToggle: () => void
}) {
    const { t } = useTranslation()

    // Determine button state
    const isConnecting = props.voiceStatus === 'connecting'
    const isConnected = props.voiceStatus === 'connected'
    const isVoiceActive = isConnecting || isConnected
    const hasText = props.canSend

    // Determine button behavior
    const handleClick = () => {
        if (isVoiceActive) {
            props.onVoiceToggle() // Stop voice
        } else if (hasText) {
            props.onSend() // Send message
        } else if (props.voiceEnabled) {
            props.onVoiceToggle() // Start voice
        }
    }

    // Determine button style and icon
    let icon: React.ReactNode
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

    const isDisabled = props.controlsDisabled || (!hasText && !props.voiceEnabled && !isVoiceActive)

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

function CodexUsageIndicator(props: { usage?: CodexUsage | null }) {
    const [open, setOpen] = useState(false)
    const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
    const buttonRef = useRef<HTMLButtonElement | null>(null)
    const percent = getCodexUsageRingPercent(props.usage)

    const updatePosition = useCallback(() => {
        const button = buttonRef.current
        if (!button) return
        const rect = button.getBoundingClientRect()
        const width = 288
        const margin = 8
        const maxLeft = Math.max(margin, window.innerWidth - width - margin)
        setPosition({
            left: Math.min(Math.max(margin, rect.right - width), maxLeft),
            bottom: Math.max(margin, window.innerHeight - rect.top + margin)
        })
    }, [])

    useLayoutEffect(() => {
        if (!open) return
        updatePosition()
        window.addEventListener('resize', updatePosition)
        window.addEventListener('scroll', updatePosition, true)
        return () => {
            window.removeEventListener('resize', updatePosition)
            window.removeEventListener('scroll', updatePosition, true)
        }
    }, [open, updatePosition])

    if (!props.usage || percent === null) {
        return null
    }

    const rows = getCodexUsageRows(props.usage)
    const roundedPercent = Math.round(percent)
    const isHighUsage = percent > 85
    const usageColor = isHighUsage ? '#991b1b' : 'var(--app-link)'
    const textColor = isHighUsage ? '#991b1b' : 'var(--app-hint)'
    const background = `conic-gradient(${usageColor} ${percent * 3.6}deg, var(--app-divider) 0deg)`

    return (
        <div className="relative">
            <button
                ref={buttonRef}
                type="button"
                aria-label="Codex usage"
                title="Codex usage"
                className="flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-normal transition-colors hover:bg-[var(--app-bg)]"
                style={{ color: textColor }}
                onClick={() => {
                    updatePosition()
                    setOpen((value) => !value)
                }}
            >
                <span
                    className="flex h-6 w-6 items-center justify-center rounded-full"
                    style={{ background }}
                >
                    <span className="flex h-[21px] w-[21px] items-center justify-center rounded-full bg-[var(--app-secondary-bg)]">
                        {roundedPercent}
                    </span>
                </span>
            </button>
            {open && position ? (
                <div
                    className="fixed z-[9999] w-72 rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] p-3 text-sm shadow-lg"
                    style={{ left: position.left, bottom: position.bottom }}
                >
                    <div className="mb-2 text-xs font-semibold uppercase text-[var(--app-hint)]">
                        Codex Usage
                    </div>
                    <div className="space-y-2">
                        {rows.map((row) => (
                            <div key={row.label} className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="text-[var(--app-fg)]">{row.label}</div>
                                    {row.detail ? (
                                        <div className="mt-0.5 break-words text-xs text-[var(--app-hint)]">{row.detail}</div>
                                    ) : null}
                                </div>
                                <div className="shrink-0 font-medium text-[var(--app-fg)]">{row.value}</div>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    )
}

export function ComposerButtons(props: {
    canSend: boolean
    controlsDisabled: boolean
    showSettingsButton: boolean
    onSettingsToggle: () => void
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
    codexUsage?: CodexUsage | null
}) {
    const { t } = useTranslation()
    const isVoiceConnected = props.voiceStatus === 'connected'

    return (
        <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1">
                <ComposerPrimitive.AddAttachment
                    aria-label={t('composer.attach')}
                    title={t('composer.attach')}
                    disabled={props.controlsDisabled}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <AttachmentIcon />
                </ComposerPrimitive.AddAttachment>

                {props.showSettingsButton ? (
                    <button
                        type="button"
                        aria-label={t('composer.settings')}
                        title={t('composer.settings')}
                        className="settings-button flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                        onClick={props.onSettingsToggle}
                        disabled={props.controlsDisabled}
                    >
                        <SettingsIcon />
                    </button>
                ) : null}

                {props.showTerminalButton ? (
                    <button
                        type="button"
                        aria-label={props.terminalLabel}
                        title={props.terminalLabel}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={props.onTerminal}
                        disabled={props.terminalDisabled}
                    >
                        <TerminalIcon />
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
            </div>

            <div className="flex items-center gap-1">
                <CodexUsageIndicator usage={props.codexUsage} />
                <UnifiedButton
                    canSend={props.canSend}
                    voiceStatus={props.voiceStatus}
                    voiceEnabled={props.voiceEnabled}
                    controlsDisabled={props.controlsDisabled}
                    onSend={props.onSend}
                    onVoiceToggle={props.onVoiceToggle}
                />
            </div>
        </div>
    )
}
