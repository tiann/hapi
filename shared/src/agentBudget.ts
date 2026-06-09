// Cross-flavor agent budget gauge shape. Seeded by the Codex usage
// indicator (tiann/hapi#537 rebase) and intended to grow to cover the
// matching axes for Claude (5h subscription window + context),
// Cursor (premium request quota + context, gated on telemetry exposure),
// and Gemini (RPM/RPD + context) under umbrella tiann/hapi#846.
//
// The shape is deliberately flavor-agnostic: each agent flavor implements
// an adapter (toCodexBudgetState, toClaudeBudgetState, ...) that maps its
// provider-specific usage payload into this normalized form. The UI
// consumes only AgentBudgetState - it knows nothing about codex credits
// or claude rate-limit headers.
//
// Design rationale (operator review 2026-06-09):
// - One ring centre number = "how much room for THIS task" (operational
//   axis, usually context window). Stays consistent regardless of
//   account-level state so the gauge does not silently change meaning.
// - Ring colour = "are you about to be blocked" (effective state across
//   ALL axes, computed by the flavor adapter which knows the specific
//   blocking semantics, e.g. 'Codex Pro credits cover an exhausted
//   subscription window so weekly=100% is amber, not red, while
//   credits>0').
// - Popover = full axis breakdown with the dominant axis marked.

export type AgentBudgetAxisId =
    | 'context'
    | 'fiveHour'
    | 'weekly'
    | 'credits'
    // Flavor-specific axes (e.g. 'cursorPremiumRequests', 'geminiRpm')
    // are permitted via plain string. Keep this loose to avoid blocking
    // new flavor adapters on a shared enum churn.
    | string

export type AgentBudgetEffectiveState =
    // All axes well under their caps - safe to keep working.
    | 'green'
    // Approaching a cap on at least one axis, or covering-axis scenario
    // (e.g. subscription window at 100% but credits available). User
    // should be aware but is not blocked.
    | 'amber'
    // Very close to a cap on at least one axis; further work may hit
    // the limit imminently.
    | 'red'
    // Hard block - no axis has remaining capacity, and there is no
    // covering axis. The agent cannot proceed.
    | 'blocked'
    // No telemetry available for this flavor / account. Adapter returns
    // null in this case; the indicator hides entirely rather than
    // surfacing a false 'green'.
    | 'unknown'

export type AgentBudgetAxis = {
    id: AgentBudgetAxisId
    label: string
    // 0-100; how close to the cap this axis is. For credit-balance axes
    // where there is no declared capacity, the adapter chooses a
    // pragmatic mapping (e.g. 0 when has-balance, 100 when zero) and
    // sets covering=true to signal the axis is a fallback rather than
    // a primary constraint.
    pressure: number
    // Pre-formatted display value (e.g. '21%', '250', '100% used').
    // The renderer should not re-derive this from pressure.
    valueText: string
    // Optional supplemental string for the popover (e.g.
    // '54k / 258k tokens', 'resets Apr 27, 1:00 PM').
    detail?: string
    // True when this axis is covering for another exhausted axis
    // (e.g. credits remaining substituting for an exhausted Codex Pro
    // weekly window). The popover highlights covering axes so the user
    // understands why the effective state is amber rather than red.
    covering?: boolean
    // Flagged as critical by the adapter (e.g. hard block on this axis).
    // The renderer paints critical-severity rows in red.
    critical?: boolean
}

// Non-pressure informational rows (e.g. token breakdown, last-turn
// usage). These render in the popover after the pressure axes but
// do not influence the ring centre, colour, or effective state.
export type AgentBudgetMetadataRow = {
    label: string
    value: string
    detail?: string
}

export type AgentBudgetState = {
    // Which axis to display as the always-visible ring centre number.
    // Defaults to 'context' for LLM agents because that is the
    // operationally relevant axis during active composition.
    operationalAxisId: AgentBudgetAxisId
    // All axes the adapter could populate. Order is significant: the
    // popover renders axes top-to-bottom in this order.
    axes: AgentBudgetAxis[]
    // Worst-case state across all axes, computed by the flavor adapter
    // using its specific blocking semantics. The renderer uses this
    // to colour the ring (not the operational-axis pressure alone).
    effective: AgentBudgetEffectiveState
    // Human-readable explanation of why the effective state is what
    // it is. Used as the ring's title / aria-label so hovering tells
    // the user 'Weekly window at cap; credits covering overage'
    // instead of just '21%'.
    effectiveReason: string
    // Which axis (if any) is currently the highest-pressure point.
    // The popover marks this row with a left-accent so the user can
    // see at a glance why the effective state landed where it did.
    dominantAxisId?: AgentBudgetAxisId
    // Non-pressure informational rows the flavor wants to surface
    // (e.g. token-by-bucket breakdown for Codex).
    metadata?: AgentBudgetMetadataRow[]
}
