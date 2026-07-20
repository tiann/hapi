import type { ReactNode } from 'react'

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

export function SettingsPageContent(props: { title: string; description?: string; children: ReactNode }) {
    return (
        <div className="mx-auto w-full max-w-[720px] space-y-5 px-3 py-4 lg:px-6 lg:py-6">
            <div>
                <h1 tabIndex={-1} className="hidden text-xl font-semibold text-[var(--app-fg)] outline-none lg:block">{props.title}</h1>
                {props.description ? <p className="text-sm text-[var(--app-hint)] lg:mt-1">{props.description}</p> : null}
            </div>
            {props.children}
        </div>
    )
}

export function SettingsSection(props: { title?: string; description?: string; children: ReactNode }) {
    return (
        <section>
            {props.title ? <h2 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">{props.title}</h2> : null}
            {props.description ? <p className="mb-2 px-1 text-sm text-[var(--app-hint)]">{props.description}</p> : null}
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
                <div className="text-[var(--app-fg)]">{props.label}</div>
                {props.description ? <div className="mt-0.5 text-xs leading-snug text-[var(--app-hint)]">{props.description}</div> : null}
                {props.children}
            </div>
            {props.trailing ? <div className="shrink-0">{props.trailing}</div> : null}
        </div>
    )
}

export function SettingsSwitch(props: { label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <SettingsRow label={props.label} description={props.description} trailing={
            <label className="relative inline-flex h-6 w-11 items-center">
                <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} className="peer sr-only" aria-label={props.label} />
                <span className="absolute inset-0 rounded-full bg-[var(--app-border)] transition-colors peer-checked:bg-[var(--app-link)]" />
                <span className="absolute left-0.5 h-5 w-5 rounded-full bg-[var(--app-bg)] shadow-sm transition-transform peer-checked:translate-x-5" />
            </label>
        } />
    )
}

export function SettingsChoiceGroup<T extends string | number>(props: {
    label: string
    value: T
    options: ReadonlyArray<{ value: T; label: string; description?: string }>
    onChange: (value: T) => void
    columns?: 2 | 4 | 5
}) {
    const columns = props.columns === 5 ? 'grid-cols-5' : props.columns === 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2'
    return (
        <fieldset className="px-3 py-3">
            <legend className="mb-2 text-[var(--app-fg)]">{props.label}</legend>
            <div role="radiogroup" aria-label={props.label} className={`grid ${columns} gap-2`}>
                {props.options.map((option) => {
                    const selected = props.value === option.value
                    return (
                        <button
                            key={String(option.value)}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => props.onChange(option.value)}
                            className={`min-w-0 rounded-lg border px-2 py-2 text-center text-sm transition-colors ${selected
                                ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)]'
                                : 'border-[var(--app-border)] text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'}`}
                        >
                            <span className="block truncate font-medium">{option.label}</span>
                            {option.description ? <span className="mt-0.5 block text-xs text-[var(--app-hint)]">{option.description}</span> : null}
                        </button>
                    )
                })}
            </div>
        </fieldset>
    )
}

export function SettingsLinkRow(props: { label: string; value?: string; description?: string; onClick: () => void }) {
    return (
        <button type="button" onClick={props.onClick} className="flex min-h-12 w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]">
            <span className="min-w-0 flex-1">
                <span className="block text-[var(--app-fg)]">{props.label}</span>
                {props.description ? <span className="mt-0.5 block text-xs text-[var(--app-hint)]">{props.description}</span> : null}
            </span>
            {props.value ? <span className="max-w-[45%] truncate text-sm text-[var(--app-hint)]">{props.value}</span> : null}
            <ChevronRightIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
        </button>
    )
}
