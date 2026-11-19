import { useEffect, useState, type ReactNode } from 'react'
import { formatDuration } from '@/chat/presentation'
import type { SessionStatusData, SessionStatusSubagent } from '@/chat/sessionStatus'
import { SessionLinkAnchor } from '@/components/SessionLinkAnchor'
import { ChecklistList } from '@/components/ToolCard/checklist'
import { useTranslation } from '@/lib/use-translation'

function LinkedSessionIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

function Section(props: { title: string; children: ReactNode }) {
    return (
        <section className="min-w-0">
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">
                {props.title}
            </h3>
            {props.children}
        </section>
    )
}

function subagentTone(state: SessionStatusSubagent['state']): string {
    if (state === 'error') return 'text-red-600'
    if (state === 'waiting') return 'text-amber-600'
    if (state === 'idle') return 'text-[var(--app-hint)]'
    return 'text-emerald-600'
}

function elapsedSince(startedAt: number | null, now: number): string | null {
    if (startedAt === null || startedAt <= 0) return null
    return formatDuration(Math.max(0, now - startedAt))
}

export function SessionStatusPanel({ data, onInspectSubagent }: {
    data: SessionStatusData
    onInspectSubagent?: (subagent: SessionStatusSubagent) => void
}) {
    const { t } = useTranslation()
    const completedTasks = data.tasks.filter((task) => task.status === 'completed').length
    const activeSubagents = data.subagents.filter(
        (subagent) => subagent.state === 'running' || subagent.state === 'waiting'
    ).length
    const errorSubagents = data.subagents.filter((subagent) => subagent.state === 'error').length
    const hasLiveElapsed = data.terminals.length > 0
        || data.subagents.some((subagent) => subagent.endedAt === null && subagent.startedAt !== null)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!hasLiveElapsed) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [hasLiveElapsed])

    const subagentCountLabel = activeSubagents > 0 && activeSubagents < data.subagents.length
        ? `${activeSubagents}/${data.subagents.length}`
        : `${data.subagents.length}`

    return (
        <details className="group mx-3 mt-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-[var(--app-fg)] [&::-webkit-details-marker]:hidden">
                <span>{t('session.status.title')}</span>
                <span className="ml-auto flex items-center gap-2 text-[11px] font-normal text-[var(--app-hint)]">
                    {data.subagents.length > 0 ? (
                        <span className={errorSubagents > 0 ? 'text-red-600' : activeSubagents > 0 ? 'text-emerald-600' : ''}>
                            {t('session.status.subagents')} {subagentCountLabel}
                        </span>
                    ) : null}
                    {data.tasks.length > 0 ? (
                        <span className="tabular-nums">
                            {t('session.status.tasks')} {completedTasks}/{data.tasks.length}
                        </span>
                    ) : null}
                    <span className="text-[10px] text-[var(--app-hint)] transition-transform group-open:rotate-180" aria-hidden="true">▼</span>
                </span>
            </summary>
            <div className="grid max-h-[min(50dvh,24rem)] gap-3 overflow-y-auto border-t border-[var(--app-border)] px-3 py-2.5 sm:grid-cols-2">
                {data.goal ? (
                    <Section title={t('session.status.goal')}>
                        <div className="break-words text-sm text-[var(--app-fg)]">{data.goal.objective}</div>
                        <div className="mt-0.5 text-xs text-[var(--app-hint)]">
                            {t(`session.status.goal.${data.goal.status}`)}
                            {data.goal.timeUsedSeconds > 0 ? ` · ${formatDuration(data.goal.timeUsedSeconds * 1000)}` : ''}
                        </div>
                    </Section>
                ) : null}

                {data.tasks.length > 0 ? (
                    <Section title={`${t('session.status.tasks')} · ${completedTasks}/${data.tasks.length}`}>
                        <ChecklistList items={data.tasks.map((task) => ({
                            id: task.id || undefined,
                            text: task.content,
                            status: task.status
                        }))} />
                    </Section>
                ) : null}

                {data.subagents.length > 0 ? (
                    <Section title={t('session.status.subagents')}>
                        <div className="flex flex-col gap-1.5">
                            {data.subagents.map((subagent) => {
                                const elapsed = elapsedSince(subagent.startedAt, subagent.endedAt ?? now)
                                const isLinkedSession = Boolean(subagent.linkedSessionId)
                                const showState = subagent.state !== 'idle'
                                const actionGlyph = isLinkedSession ? '↗' : onInspectSubagent ? '›' : null
                                const body = (
                                    <>
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            {isLinkedSession ? (
                                                <LinkedSessionIcon className={`h-3 w-3 shrink-0 ${subagentTone(subagent.state)}`} />
                                            ) : (
                                                <span className={`shrink-0 text-xs ${subagentTone(subagent.state)}`}>●</span>
                                            )}
                                            <span className="min-w-0 truncate text-[var(--app-fg)]">{subagent.title}</span>
                                            {subagent.linkKind && subagent.linkKind !== 'peer' ? (
                                                <span className="shrink-0 rounded bg-[var(--app-bg)] px-1 py-px text-[10px] leading-none text-[var(--app-hint)]">
                                                    {t(`sessions.lineage.kind.${subagent.linkKind}`)}
                                                </span>
                                            ) : null}
                                            {showState ? (
                                                <span className={`ml-auto shrink-0 text-xs ${subagentTone(subagent.state)}`}>
                                                    {t(`session.status.subagent.${subagent.state}`)}
                                                    {elapsed ? ` · ${elapsed}` : ''}
                                                </span>
                                            ) : null}
                                            {actionGlyph ? (
                                                <span
                                                    className={`${showState ? '' : 'ml-auto '}shrink-0 text-xs text-[var(--app-hint)]`}
                                                    aria-hidden="true"
                                                >
                                                    {actionGlyph}
                                                </span>
                                            ) : null}
                                        </div>
                                        {subagent.detail ? (
                                            <div className="ml-4 break-words text-xs text-[var(--app-hint)]">{subagent.detail}</div>
                                        ) : null}
                                    </>
                                )
                                if (subagent.linkedSessionId) {
                                    return (
                                        <SessionLinkAnchor
                                            key={subagent.id}
                                            sessionId={subagent.linkedSessionId}
                                            aria-label={`${t('sessions.lineage.openSession')}: ${subagent.title}`}
                                            onClick={(event) => {
                                                if (
                                                    onInspectSubagent
                                                    && event.button === 0
                                                    && !event.metaKey
                                                    && !event.ctrlKey
                                                    && !event.shiftKey
                                                    && !event.altKey
                                                ) {
                                                    event.preventDefault()
                                                    onInspectSubagent(subagent)
                                                }
                                            }}
                                            className="block min-w-0 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-[var(--app-bg)] touch-manipulation"
                                        >
                                            {body}
                                        </SessionLinkAnchor>
                                    )
                                }
                                return onInspectSubagent ? (
                                    <button
                                        key={subagent.id}
                                        type="button"
                                        onClick={() => onInspectSubagent(subagent)}
                                        aria-label={`${t('session.status.inspectSubagent')}: ${subagent.title}`}
                                        className="min-w-0 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-[var(--app-bg)] touch-manipulation"
                                    >
                                        {body}
                                    </button>
                                ) : (
                                    <div key={subagent.id} className="min-w-0 text-sm">
                                        {body}
                                    </div>
                                )
                            })}
                        </div>
                    </Section>
                ) : null}

                {data.terminals.length > 0 ? (
                    <Section title={t('session.status.terminals')}>
                        <div className="flex flex-col gap-1.5">
                            {data.terminals.map((terminal) => {
                                const elapsed = elapsedSince(terminal.startedAt, now)
                                return (
                                    <div key={terminal.id} className="min-w-0">
                                        <code className="block overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[var(--app-fg)]" title={terminal.command}>
                                            {terminal.command}
                                        </code>
                                        {(terminal.cwd || elapsed) ? (
                                            <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-[var(--app-hint)]">
                                                {[terminal.cwd, elapsed].filter(Boolean).join(' · ')}
                                            </div>
                                        ) : null}
                                    </div>
                                )
                            })}
                        </div>
                    </Section>
                ) : null}
            </div>
        </details>
    )
}
