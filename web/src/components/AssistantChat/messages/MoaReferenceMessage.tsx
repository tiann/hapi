import { useMemo } from 'react'

export type MoaReferenceData = {
    label: string
    text: string
    index?: number
    count?: number
}

export function getMoaReferenceTitle(reference: MoaReferenceData): string {
    if (typeof reference.index === 'number' && typeof reference.count === 'number') {
        return `MoA reference ${reference.index}/${reference.count} · ${reference.label}`
    }
    return `MoA reference · ${reference.label}`
}

export function MoaReferenceMessage(props: { reference: MoaReferenceData }) {
    const title = useMemo(() => getMoaReferenceTitle(props.reference), [props.reference])

    return (
        <details
            data-testid="moa-reference-details"
            className="my-2 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40"
        >
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)]">
                {title}
            </summary>
            <div className="border-t border-[var(--app-border)] px-3 py-2">
                <pre className="m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--app-fg)]">
                    {props.reference.text}
                </pre>
            </div>
        </details>
    )
}
