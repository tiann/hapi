// Shared chip styling between MachineFilterBar and BoardSwitcher — both
// render a wrapping row of selectable pill buttons with the same selected/idle
// treatment.
export const chipBaseClass = 'flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors'
export const chipSelectedClass = 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)] font-medium'
export const chipIdleClass = 'border-[var(--app-border)] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
