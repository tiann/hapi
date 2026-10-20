import type { ReactNode } from 'react'

export function SettingsFieldLabel(props: { children: ReactNode; hidden?: boolean; description?: string }) {
    if (props.hidden) return null
    if (!props.description) return <div className="mb-2 text-sm font-medium text-[var(--app-fg)]">{props.children}</div>
    return (
        <div className="mb-2">
            <div className="text-sm font-medium text-[var(--app-fg)]">{props.children}</div>
            <div className="mt-0.5 text-xs leading-snug text-[var(--app-hint)]">{props.description}</div>
        </div>
    )
}

export function ChevronRightIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={props.className} aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
        </svg>
    )
}

export function CheckIcon(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={props.className} aria-hidden="true">
            <path d="m20 6-11 11-5-5" />
        </svg>
    )
}

export function SettingsPageContent(props: { description?: string; children: ReactNode }) {
    return (
        <div className="mx-auto w-full max-w-[720px] space-y-5 pl-3 pr-[10px] py-4 lg:px-6 lg:py-6">
            <div>
                {props.description ? <p className="text-sm text-[var(--app-hint)]">{props.description}</p> : null}
            </div>
            {props.children}
        </div>
    )
}

export function SettingsSection(props: { title?: string; description?: string; children: ReactNode }) {
    return (
        <section>
            {props.title ? <h2 className="mb-2 text-base font-semibold text-[var(--app-fg)]">{props.title}</h2> : null}
            {props.description ? <p className="mb-2 text-sm text-[var(--app-hint)]">{props.description}</p> : null}
            <div className="overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm divide-y divide-[var(--app-divider)]">
                {props.children}
            </div>
        </section>
    )
}

export function SettingsRow(props: { label: string; description?: string; trailing?: ReactNode; children?: ReactNode }) {
    return (
        <div className="flex min-h-12 items-center justify-between gap-3 px-3 py-3">
            <div className="min-w-0">
                <div className="text-sm font-medium text-[var(--app-fg)]">{props.label}</div>
                {props.description ? <div className="mt-0.5 text-xs leading-snug text-[var(--app-hint)]">{props.description}</div> : null}
                {props.children}
            </div>
            {props.trailing ? <div className="shrink-0">{props.trailing}</div> : null}
        </div>
    )
}

export function SettingsSwitch(props: {
    label: string
    description?: string
    checked: boolean
    onChange: (checked: boolean) => void
    leftLabel?: string
    rightLabel?: string
}) {
    const leftLabel = props.leftLabel ?? 'Off'
    const rightLabel = props.rightLabel ?? 'On'
    return (
        <div className="px-3 py-3">
            <SettingsFieldLabel description={props.description}>{props.label}</SettingsFieldLabel>
            <div className="relative grid h-11 grid-cols-2 overflow-hidden rounded-full border border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
                <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-4px)] rounded-full border border-[var(--app-border)] bg-[var(--app-bg)] shadow-sm transition-transform duration-150 ${props.checked ? 'translate-x-[calc(100%+4px)]' : 'translate-x-0'}`}
                />
                <input
                    type="checkbox"
                    checked={props.checked}
                    onChange={(event) => props.onChange(event.target.checked)}
                    className="sr-only"
                    aria-label={props.label}
                />
                <button
                    type="button"
                    aria-pressed={!props.checked}
                    onClick={() => { if (props.checked) props.onChange(false) }}
                    className={`relative z-10 truncate px-2 text-sm font-medium transition-colors ${props.checked ? 'text-[var(--app-hint)]' : 'text-[var(--app-fg)]'}`}
                >
                    {leftLabel}
                </button>
                <button
                    type="button"
                    aria-pressed={props.checked}
                    onClick={() => { if (!props.checked) props.onChange(true) }}
                    className={`relative z-10 truncate px-2 text-sm font-medium transition-colors ${props.checked ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                >
                    {rightLabel}
                </button>
            </div>
        </div>
    )
}

export function SettingsChoiceGroup<T extends string | number>(props: {
    label: string
    description?: string
    hideLabel?: boolean
    value: T
    options: ReadonlyArray<{ value: T; label: string; description?: string }>
    onChange: (value: T) => void
    columns?: 2 | 4 | 5 | 6
}) {
    const columns = props.columns === 6 ? 'grid-cols-6' : props.columns === 5 ? 'grid-cols-5' : props.columns === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2'
    return (
        <div className={`${props.columns === 6 ? 'px-1 sm:px-3' : 'px-3'} py-3`}>
            <SettingsFieldLabel hidden={props.hideLabel} description={props.description}>{props.label}</SettingsFieldLabel>
            <div role="radiogroup" aria-label={props.label} className={`grid ${columns} ${props.columns === 6 ? 'gap-px sm:gap-1' : 'gap-2'}`}>
                {props.options.map((option) => {
                    const selected = props.value === option.value
                    return (
                        <button
                            key={String(option.value)}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => props.onChange(option.value)}
                            className={`min-w-0 rounded-lg border ${props.columns === 6 ? 'px-0 text-xs tracking-tight sm:text-sm sm:tracking-normal' : 'px-2 text-sm'} py-2 text-center transition-colors ${selected
                                ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
                                : 'border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                        >
                            <span className="block truncate font-medium">{option.label}</span>
                            {option.description ? <span className="mt-0.5 block text-xs text-[var(--app-hint)]">{option.description}</span> : null}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}

export function SettingsLinkRow(props: { label: string; value?: string; description?: string; onClick: () => void }) {
    return (
        <button type="button" onClick={props.onClick} className="flex min-h-12 w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]">
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-[var(--app-fg)]">{props.label}</span>
                {props.description ? <span className="mt-0.5 block text-xs text-[var(--app-hint)]">{props.description}</span> : null}
            </span>
            {props.value ? <span className="max-w-[45%] truncate text-sm text-[var(--app-hint)]">{props.value}</span> : null}
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
        </button>
    )
}
