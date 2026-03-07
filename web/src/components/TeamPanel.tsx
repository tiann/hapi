import { useState } from 'react'
import type { TeamState } from '@hapi/protocol/types'

function memberStatusDot(status?: string): string {
    if (status === 'active') return 'bg-emerald-500'
    if (status === 'shutdown') return 'bg-red-500'
    return 'bg-gray-400'
}

function taskStatusColor(status?: string): string {
    if (status === 'completed') return 'text-emerald-600'
    if (status === 'in_progress') return 'text-[var(--app-link)]'
    if (status === 'blocked') return 'text-red-500'
    return 'text-[var(--app-hint)]'
}

function taskStatusIcon(status?: string): string {
    if (status === 'completed') return '\u2611'
    if (status === 'in_progress') return '\u25b6'
    if (status === 'blocked') return '\u26a0'
    return '\u2610'
}

export function TeamPanel(props: { teamState: TeamState }) {
    const [expanded, setExpanded] = useState(false)
    const { teamState } = props
    const members = teamState.members ?? []
    const tasks = teamState.tasks ?? []
    const messages = teamState.messages ?? []

    const completedTasks = tasks.filter(t => t.status === 'completed').length
    const activeMembers = members.filter(m => m.status === 'active').length

    return (
        <div className="mx-3 mt-3">
            <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="flex w-full items-center gap-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
            >
                <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
                <span className="font-medium text-[var(--app-fg)]">
                    Team: {teamState.teamName}
                </span>
                <span className="text-xs text-[var(--app-hint)]">
                    {members.length} member{members.length !== 1 ? 's' : ''}
                    {activeMembers > 0 ? ` (${activeMembers} active)` : ''}
                    {tasks.length > 0 ? ` \u00b7 ${completedTasks}/{tasks.length} tasks` : ''}
                </span>
                <svg
                    className={`ml-auto h-3 w-3 shrink-0 text-[var(--app-hint)] transition-transform ${expanded ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                >
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </button>

            {expanded && (
                <div className="mt-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2">
                    {teamState.description && (
                        <p className="mb-2 text-xs text-[var(--app-hint)]">{teamState.description}</p>
                    )}

                    {/* Members */}
                    {members.length > 0 && (
                        <div className="mb-2">
                            <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">Members</div>
                            <div className="flex flex-wrap gap-2">
                                {members.map((member) => (
                                    <div
                                        key={member.name}
                                        className="flex items-center gap-1.5 rounded-full bg-[var(--app-subtle-bg)] px-2 py-0.5 text-xs"
                                    >
                                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${memberStatusDot(member.status)}`} />
                                        <span className="text-[var(--app-fg)]">{member.name}</span>
                                        {member.agentType && (
                                            <span className="text-[var(--app-hint)]">({member.agentType})</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Tasks */}
                    {tasks.length > 0 && (
                        <div className="mb-2">
                            <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">Tasks</div>
                            <div className="flex flex-col gap-0.5">
                                {tasks.map((task, idx) => (
                                    <div key={task.id ?? String(idx)} className={`text-xs ${taskStatusColor(task.status)}`}>
                                        <span>{taskStatusIcon(task.status)}</span>
                                        {' '}
                                        <span>{task.title}</span>
                                        {task.owner && (
                                            <span className="ml-1 text-[var(--app-hint)]">[{task.owner}]</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Recent Messages */}
                    {messages.length > 0 && (
                        <div>
                            <div className="mb-1 text-xs font-medium text-[var(--app-hint)]">Recent Messages</div>
                            <div className="flex flex-col gap-0.5">
                                {messages.slice(-5).map((msg, idx) => (
                                    <div key={idx} className="text-xs text-[var(--app-hint)]">
                                        <span className="text-[var(--app-fg)]">{msg.from}</span>
                                        {' \u2192 '}
                                        <span className="text-[var(--app-fg)]">{msg.to}</span>
                                        {': '}
                                        <span>{msg.summary}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
