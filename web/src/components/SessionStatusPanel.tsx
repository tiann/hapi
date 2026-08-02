import { useEffect, useState, type ReactNode } from 'react'
import { formatDuration } from '@/chat/presentation'
import type { SessionStatusData, SessionStatusSubagent } from '@/chat/sessionStatus'
import { ChecklistList } from '@/components/ToolCard/checklist'
import { useTranslation } from '@/lib/use-translation'

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
    return 'text-emerald-600'
}

function elapsedSince(startedAt: number | null, now: number): string | null {
    if (startedAt === null || startedAt <= 0) return null
    return formatDuration(Math.max(0, now - startedAt))
}

export function SessionStatusPanel({ data }: { data: SessionStatusData }) {
    const { t } = useTranslation()
    const completedTasks = data.tasks.filter((task) => task.status === 'completed').length
    const hasLiveElapsed = data.terminals.length > 0
        || data.subagents.some((subagent) => subagent.endedAt === null && subagent.startedAt !== null)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!hasLiveElapsed) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [hasLiveElapsed])

    return (
        <details className="group mx-3 mt-3 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-[var(--app-fg)] [&::-webkit-details-marker]:hidden">
                {t('session.status.title')}
                <span className="ml-auto text-[10px] text-[var(--app-hint)] transition-transform group-open:rotate-180" aria-hidden="true">▼</span>
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
                                return (
                                    <div key={subagent.id} className="min-w-0 text-sm">
                                        <div className="flex min-w-0 items-baseline gap-1.5">
                                            <span className={`shrink-0 text-xs ${subagentTone(subagent.state)}`}>●</span>
                                            <span className="min-w-0 break-words text-[var(--app-fg)]">{subagent.title}</span>
                                            <span className={`ml-auto shrink-0 text-xs ${subagentTone(subagent.state)}`}>
                                                {t(`session.status.subagent.${subagent.state}`)}
                                                {elapsed ? ` · ${elapsed}` : ''}
                                            </span>
                                        </div>
                                        {subagent.detail ? (
                                            <div className="ml-3.5 break-words text-xs text-[var(--app-hint)]">{subagent.detail}</div>
                                        ) : null}
                                    </div>
                                )
                            })}
                        </div>
                    </Section>
                ) : null}

                {data.terminals.length > 0 || data.undiscoveredTerminalCount > 0 ? (
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
                            {data.undiscoveredTerminalCount > 0 ? (
                                <>
                                    <div className="text-xs text-[var(--app-hint)]">
                                        {t('session.status.terminalsUnavailable', { count: data.undiscoveredTerminalCount })}
                                    </div>
                                    {data.possibleTerminalCommands.length > 0 ? (
                                        <div className="text-[11px] text-[var(--app-hint)]">
                                            {t('session.status.terminalsPossible')}
                                            {data.possibleTerminalCommands.map((command, index) => (
                                                <code key={`${command}:${index}`} className="block overflow-hidden text-ellipsis whitespace-nowrap" title={command}>{command}</code>
                                            ))}
                                        </div>
                                    ) : null}
                                </>
                            ) : null}
                        </div>
                    </Section>
                ) : null}
            </div>
        </details>
    )
}
