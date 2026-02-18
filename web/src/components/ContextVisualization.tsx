import { useMemo, useState } from 'react'
import type { ContextData, ContextSection } from '@/lib/parseContextOutput'

const CATEGORY_COLORS: Record<string, string> = {
    'System prompt': '#3b82f6',       // blue
    'System tools': '#6366f1',        // indigo
    'MCP tools (deferred)': '#a855f7', // purple
    'Custom agents': '#06b6d4',       // cyan
    'Memory files': '#f59e0b',        // amber
    'Skills': '#22c55e',              // green
    'Messages': '#f43f5e',            // rose
    'Free space': 'var(--app-border)', // gray
    'Autocompact buffer': 'var(--app-hint)', // gray hint
}

function getCategoryColor(name: string): string {
    return CATEGORY_COLORS[name] ?? 'var(--app-hint)'
}

function formatTokens(tokens: number): string {
    if (tokens >= 1_000_000) {
        return `${(tokens / 1_000_000).toFixed(1)}M`
    }
    if (tokens >= 1_000) {
        return `${(tokens / 1_000).toFixed(1)}k`
    }
    return String(tokens)
}

function CategoryBar(props: {
    name: string
    tokens: number
    percentage: number
    maxPercentage: number
    expanded: boolean
    onToggle: () => void
    section?: ContextSection
}) {
    const color = getCategoryColor(props.name)
    const isFreeSpace = props.name === 'Free space'
    const isBuffer = props.name === 'Autocompact buffer'
    const barWidth = props.maxPercentage > 0 ? (props.percentage / props.maxPercentage) * 100 : 0

    return (
        <div>
            <button
                type="button"
                className={`w-full text-left transition-colors rounded-md px-2 py-1.5 ${
                    props.section ? 'cursor-pointer hover:bg-[var(--app-subtle-bg)]' : 'cursor-default'
                }`}
                onClick={props.section ? props.onToggle : undefined}
            >
                <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                        <span
                            className="h-2.5 w-2.5 shrink-0 rounded-sm"
                            style={{
                                backgroundColor: isFreeSpace || isBuffer ? 'transparent' : color,
                                border: isFreeSpace || isBuffer ? `1.5px ${isBuffer ? 'dashed' : 'solid'} ${color}` : 'none'
                            }}
                        />
                        <span className="truncate text-[var(--app-fg)]">{props.name}</span>
                        {props.section ? (
                            <span className="text-[10px] text-[var(--app-hint)]">
                                {props.expanded ? '▼' : '▶'}
                            </span>
                        ) : null}
                    </div>
                    <div className="flex items-center gap-2 shrink-0 tabular-nums">
                        <span className="text-[var(--app-hint)]">{formatTokens(props.tokens)}</span>
                        <span className="text-[var(--app-hint)] w-10 text-right">{props.percentage.toFixed(1)}%</span>
                    </div>
                </div>
                {!isFreeSpace && !isBuffer ? (
                    <div className="mt-1 h-1.5 w-full rounded-full bg-[var(--app-subtle-bg)] overflow-hidden">
                        <div
                            className="h-full rounded-full transition-all"
                            style={{
                                width: `${Math.max(barWidth, 0.5)}%`,
                                backgroundColor: color
                            }}
                        />
                    </div>
                ) : null}
            </button>

            {props.expanded && props.section ? (
                <div className="ml-5 mt-1 mb-2 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] overflow-hidden">
                    <div className="max-h-48 overflow-y-auto">
                        <table className="w-full text-[11px]">
                            <thead>
                                <tr className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
                                    {props.section.columns.map((col, i) => (
                                        <th
                                            key={col}
                                            className={`px-2 py-1 font-medium text-[var(--app-hint)] ${
                                                i === props.section!.columns.length - 1 ? 'text-right' : 'text-left'
                                            }`}
                                        >
                                            {col}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {props.section.rows.map((row, i) => (
                                    <tr key={i} className="border-b border-[var(--app-border)]/50 last:border-b-0">
                                        <td className="px-2 py-0.5 font-mono text-[var(--app-fg)] truncate max-w-[200px]">
                                            {row.name}
                                        </td>
                                        {row.extra ? (
                                            <td className="px-2 py-0.5 text-[var(--app-hint)]">{row.extra}</td>
                                        ) : null}
                                        <td className="px-2 py-0.5 text-right text-[var(--app-hint)] tabular-nums">
                                            {formatTokens(row.tokens)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : null}
        </div>
    )
}

export function ContextVisualization(props: { data: ContextData }) {
    const { data } = props
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())

    const toggleSection = (name: string) => {
        setExpandedSections(prev => {
            const next = new Set(prev)
            if (next.has(name)) {
                next.delete(name)
            } else {
                next.add(name)
            }
            return next
        })
    }

    // Map section titles to category names for expandability
    const sectionByCategory = useMemo(() => {
        const map = new Map<string, ContextSection>()
        for (const section of data.sections) {
            // Match section titles to category names
            if (section.title.includes('MCP')) map.set('MCP tools (deferred)', section)
            else if (section.title.includes('Agent')) map.set('Custom agents', section)
            else if (section.title.includes('Memory')) map.set('Memory files', section)
            else if (section.title.includes('Skill')) map.set('Skills', section)
        }
        return map
    }, [data.sections])

    const maxPercentage = useMemo(
        () => Math.max(...data.categories.map(c => c.percentage), 1),
        [data.categories]
    )

    // Stacked overview bar
    const usedCategories = data.categories.filter(
        c => c.name !== 'Free space' && c.name !== 'Autocompact buffer' && c.percentage > 0
    )

    return (
        <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] overflow-hidden">
            {/* Header */}
            <div className="px-3 pt-3 pb-2">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                        <svg className="h-4 w-4 text-[var(--app-hint)]" viewBox="0 0 16 16" fill="none">
                            <rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
                            <rect x="3" y="6" width="4" height="1.5" rx="0.5" fill="currentColor" />
                            <rect x="3" y="9" width="7" height="1.5" rx="0.5" fill="currentColor" opacity="0.5" />
                        </svg>
                        <span className="text-sm font-medium text-[var(--app-fg)]">Context Usage</span>
                    </div>
                    {data.model ? (
                        <span className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs font-mono text-[var(--app-hint)]">
                            {data.model}
                        </span>
                    ) : null}
                </div>

                {/* Summary line */}
                <div className="mt-1.5 flex items-baseline gap-1.5">
                    <span className="text-lg font-semibold tabular-nums text-[var(--app-fg)]">
                        {formatTokens(data.totalTokens)}
                    </span>
                    <span className="text-sm text-[var(--app-hint)]">
                        / {formatTokens(data.maxTokens)}
                    </span>
                    <span className={`ml-1 text-sm font-medium tabular-nums ${
                        data.usagePercentage > 80 ? 'text-[#f43f5e]'
                            : data.usagePercentage > 60 ? 'text-[#f59e0b]'
                                : 'text-[#22c55e]'
                    }`}>
                        {data.usagePercentage.toFixed(1)}%
                    </span>
                </div>

                {/* Stacked bar */}
                <div className="mt-2 h-3 w-full rounded-full bg-[var(--app-subtle-bg)] overflow-hidden flex">
                    {usedCategories.map((cat) => (
                        <div
                            key={cat.name}
                            className="h-full transition-all first:rounded-l-full last:rounded-r-full"
                            style={{
                                width: `${cat.percentage}%`,
                                backgroundColor: getCategoryColor(cat.name),
                                minWidth: cat.percentage > 0 ? '2px' : '0'
                            }}
                            title={`${cat.name}: ${formatTokens(cat.tokens)} (${cat.percentage.toFixed(1)}%)`}
                        />
                    ))}
                </div>
            </div>

            {/* Category breakdown */}
            <div className="px-1 pb-2">
                {data.categories.map((cat) => (
                    <CategoryBar
                        key={cat.name}
                        name={cat.name}
                        tokens={cat.tokens}
                        percentage={cat.percentage}
                        maxPercentage={maxPercentage}
                        expanded={expandedSections.has(cat.name)}
                        onToggle={() => toggleSection(cat.name)}
                        section={sectionByCategory.get(cat.name)}
                    />
                ))}
            </div>
        </div>
    )
}
