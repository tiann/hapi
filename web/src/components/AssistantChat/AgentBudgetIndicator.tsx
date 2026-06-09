import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { AgentBudgetAxis, AgentBudgetEffectiveState, AgentBudgetState } from '@hapi/protocol/types'

// Flavor-agnostic budget indicator. Consumes a normalized AgentBudgetState
// (see shared/src/agentBudget.ts) so it works for any agent flavor that
// can produce that shape - Codex today, Claude / Cursor / Gemini under
// umbrella tiann/hapi#846 as their adapters land.
//
// Visual contract (operator review 2026-06-09):
// - Centre number = state.operationalAxisId's pressure (usually context).
//   Stays consistent across all account states so the gauge never
//   silently changes meaning between context-fill and usage-exhaustion.
// - Ring colour = state.effective (green / amber / red / blocked).
//   Computed by the flavor adapter using its specific blocking rules
//   (e.g. Codex Pro credits cover an exhausted subscription window so
//   weekly=100% with credits>0 is amber, not red).
// - Popover = full axis breakdown + metadata rows, with the dominant
//   axis row carrying a left-accent + bold so the user can see at a
//   glance why the ring colour landed where it did.

type EffectivePalette = {
    ring: string
    text: string
    accent: string
}

const PALETTE: Record<AgentBudgetEffectiveState, EffectivePalette> = {
    green: { ring: 'var(--app-link)', text: 'var(--app-hint)', accent: 'var(--app-link)' },
    amber: { ring: '#b45309', text: '#b45309', accent: '#b45309' },
    red: { ring: '#991b1b', text: '#991b1b', accent: '#991b1b' },
    blocked: { ring: '#991b1b', text: '#991b1b', accent: '#991b1b' },
    // Unknown should never reach the renderer (adapter returns null
    // instead, hiding the indicator) - mapped to green defensively.
    unknown: { ring: 'var(--app-link)', text: 'var(--app-hint)', accent: 'var(--app-link)' }
}

function operationalAxis(state: AgentBudgetState): AgentBudgetAxis | undefined {
    return state.axes.find((axis) => axis.id === state.operationalAxisId)
}

export function AgentBudgetIndicator(props: { state: AgentBudgetState | null | undefined; popoverTitle?: string }) {
    const [open, setOpen] = useState(false)
    const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
    const buttonRef = useRef<HTMLButtonElement | null>(null)

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

    if (!props.state) return null

    const state = props.state
    const opAxis = operationalAxis(state)
    // The ring centre is the operational axis pressure; ring fill is the
    // EFFECTIVE pressure (max axis) so a red-effective state with low
    // context still visibly fills the ring. Without this, an amber/red
    // state with context=20 would render 'amber colour, 20% fill' which
    // looks like a healthy account.
    const opPressure = opAxis ? opAxis.pressure : 0
    const effectivePressure = Math.max(...state.axes.map((a) => a.pressure), 0)
    const palette = PALETTE[state.effective]
    const fillPercent = state.effective === 'blocked' ? 100 : Math.max(opPressure, effectivePressure)
    const background = `conic-gradient(${palette.ring} ${fillPercent * 3.6}deg, var(--app-divider) 0deg)`
    const centreNumber = Math.round(opPressure)
    const tooltip = state.effectiveReason

    return (
        <div className="relative">
            <button
                ref={buttonRef}
                type="button"
                aria-label={tooltip}
                title={tooltip}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-normal transition-colors hover:bg-[var(--app-bg)]"
                style={{ color: palette.text }}
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
                        {centreNumber}
                    </span>
                </span>
            </button>
            {open && position ? (
                <div
                    className="fixed z-[9999] w-72 rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)] p-3 text-sm shadow-lg"
                    style={{ left: position.left, bottom: position.bottom }}
                >
                    <div className="mb-2 text-xs font-semibold uppercase text-[var(--app-hint)]">
                        {props.popoverTitle ?? 'Agent Budget'}
                    </div>
                    <div className="mb-2 text-xs text-[var(--app-hint)]">{tooltip}</div>
                    <div className="space-y-2">
                        {state.axes.map((axis) => {
                            const isDominant = state.dominantAxisId === axis.id
                            const isCritical = axis.critical === true
                            const isCovering = axis.covering === true
                            const labelColor = isCritical ? '#991b1b' : 'var(--app-fg)'
                            const valueColor = isCritical ? '#991b1b' : 'var(--app-fg)'
                            const borderColor = isCritical
                                ? '#991b1b'
                                : isDominant
                                    ? palette.accent
                                    : isCovering
                                        ? 'var(--app-link)'
                                        : 'transparent'
                            const emphasised = isCritical || isDominant
                            return (
                                <div
                                    key={axis.id}
                                    className="flex items-start justify-between gap-3 rounded-sm pl-2 -ml-2"
                                    style={{ borderLeft: `3px solid ${borderColor}` }}
                                >
                                    <div className="min-w-0">
                                        <div style={{ color: labelColor }} className={emphasised ? 'font-semibold' : undefined}>{axis.label}</div>
                                        {axis.detail ? (
                                            <div className="mt-0.5 break-words text-xs text-[var(--app-hint)]">{axis.detail}</div>
                                        ) : null}
                                    </div>
                                    <div className="shrink-0 font-medium" style={{ color: valueColor }}>{axis.valueText}</div>
                                </div>
                            )
                        })}
                        {state.metadata && state.metadata.length > 0 ? (
                            <div className="mt-3 border-t border-[var(--app-divider)] pt-2 space-y-2">
                                {state.metadata.map((row) => (
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
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    )
}
