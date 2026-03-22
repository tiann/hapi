import { useMemo, useState } from 'react'
import type { TeamState, TeamMember, TeamTask, TeamMessage, TeamPermission, DecryptedMessage } from '@hapi/protocol/types'
import type { ApiClient } from '@/api/client'
import { isObject } from '@hapi/protocol'

// --- Teammate activity extraction from conversation messages ---

type TeammateActivity = {
    memberName: string
    toolCalls: Array<{ name: string; description: string | null; id: string }>
    lastOutput: string | null
    timestamp: number
}

/**
 * Extract per-member activity from conversation messages by looking at
 * Agent tool calls (which spawn subagents) and their tool_result blocks.
 */
function extractTeammateActivities(messages: DecryptedMessage[]): Map<string, TeammateActivity> {
    const activities = new Map<string, TeammateActivity>()

    for (const msg of messages) {
        const content = msg.content
        if (!isObject(content) || content.type !== 'output') continue
        const data = isObject(content.data) ? content.data : null
        if (!data) continue

        if (data.type === 'assistant') {
            const message = isObject(data.message) ? data.message : null
            if (!message) continue
            const blocks = Array.isArray(message.content) ? message.content : []
            for (const block of blocks) {
                if (!isObject(block)) continue
                // Agent tool call - spawning a subagent
                if (block.type === 'tool_use' && block.name === 'Agent') {
                    const input = isObject(block.input) ? block.input as Record<string, unknown> : null
                    if (!input) continue
                    const name = typeof input.name === 'string' ? input.name : null
                    if (!name) continue
                    const desc = typeof input.description === 'string' ? input.description : null
                    if (!activities.has(name)) {
                        activities.set(name, {
                            memberName: name,
                            toolCalls: [],
                            lastOutput: null,
                            timestamp: msg.createdAt
                        })
                    }
                    const activity = activities.get(name)!
                    activity.timestamp = msg.createdAt
                    if (desc) {
                        activity.toolCalls = [{ name: 'Agent', description: desc, id: typeof block.id === 'string' ? block.id : '' }]
                    }
                }
            }
        }

        // Tool results for Agent calls contain the subagent's output
        if (data.type === 'user') {
            const message = isObject(data.message) ? data.message : null
            if (!message) continue
            const blocks = Array.isArray(message.content) ? message.content : []
            for (const block of blocks) {
                if (!isObject(block) || block.type !== 'tool_result') continue
                const rawContent = 'content' in block ? block.content : null
                if (typeof rawContent !== 'string') continue
                // Try to match this result to a known member
                for (const [name, activity] of activities) {
                    const toolId = activity.toolCalls[0]?.id
                    if (toolId && typeof block.tool_use_id === 'string' && block.tool_use_id === toolId) {
                        // Truncate long outputs
                        activity.lastOutput = rawContent.length > 500 ? rawContent.slice(-500) : rawContent
                        activity.timestamp = msg.createdAt
                    }
                }
            }
        }
    }

    return activities
}

// --- Styling helpers ---

function memberStatusColor(status?: string): string {
    switch (status) {
        case 'active': return 'bg-blue-500'
        case 'idle': return 'bg-emerald-500'
        case 'completed': return 'bg-blue-500'
        case 'error': return 'bg-red-500'
        case 'shutdown': return 'bg-gray-400'
        default: return 'bg-gray-400'
    }
}

function memberStatusLabel(status?: string): string {
    switch (status) {
        case 'active': return 'In Progress'
        case 'idle': return 'Idle'
        case 'completed': return 'Done'
        case 'error': return 'Error'
        case 'shutdown': return 'Stopped'
        default: return 'Unknown'
    }
}

function taskStatusIcon(status?: string): string {
    switch (status) {
        case 'completed': return '\u2713'
        case 'in_progress': return '\u25CF'
        case 'blocked': return '\u26A0'
        default: return '\u25CB'
    }
}

function taskStatusClass(status?: string): string {
    switch (status) {
        case 'completed': return 'text-emerald-500'
        case 'in_progress': return 'text-[var(--app-link)]'
        case 'blocked': return 'text-red-500'
        default: return 'text-[var(--app-hint)]'
    }
}

// --- Components ---

function PermissionCard({ permission, onApprove, onDeny }: {
    permission: TeamPermission
    onApprove: () => void | Promise<void>
    onDeny: () => void | Promise<void>
}) {
    const [acted, setActed] = useState<'approve' | 'deny' | null>(null)
    const [loading, setLoading] = useState(false)

    const handleApprove = async () => {
        setLoading(true)
        setActed('approve')
        try {
            await onApprove()
        } finally {
            setLoading(false)
        }
    }

    const handleDeny = async () => {
        setLoading(true)
        setActed('deny')
        try {
            await onDeny()
        } finally {
            setLoading(false)
        }
    }

    if (acted) {
        return (
            <div className="rounded border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--app-hint)]">
                    <span>{acted === 'approve' ? '✓' : '✕'}</span>
                    <span>{permission.toolName} — {acted === 'approve' ? 'allowed' : 'denied'}</span>
                </div>
            </div>
        )
    }

    return (
        <div className="rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
                <span className="text-amber-600">🔐</span>
                <span className="font-medium text-[var(--app-fg)]">{permission.toolName}</span>
            </div>
            {permission.description && (
                <div className="mt-0.5 text-[10px] text-[var(--app-hint)]">
                    {permission.description}
                </div>
            )}
            <div className="mt-1.5 flex gap-1.5">
                <button
                    type="button"
                    onClick={handleApprove}
                    className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-emerald-700"
                >
                    Allow
                </button>
                <button
                    type="button"
                    onClick={handleDeny}
                    className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-red-700"
                >
                    Deny
                </button>
            </div>
        </div>
    )
}

function MemberCard({ member, activity, permissions, onApprovePermission, onDenyPermission }: {
    member: TeamMember
    activity?: TeammateActivity
    permissions: TeamPermission[]
    onApprovePermission?: (permission: TeamPermission) => void
    onDenyPermission?: (permission: TeamPermission) => void
}) {
    const [expanded, setExpanded] = useState(false)
    const isActive = member.status === 'active'
    const hasPendingPerms = permissions.length > 0

    // Auto-expand when there are pending permissions
    const shouldExpand = expanded || hasPendingPerms

    return (
        <div className="overflow-hidden rounded-md bg-[var(--app-subtle-bg)]">
            <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
            >
                <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${memberStatusColor(member.status)} ${isActive ? 'animate-pulse' : ''}`} />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-[var(--app-fg)]">
                            {member.name}
                        </span>
                        {hasPendingPerms && (
                            <span className="shrink-0 animate-pulse rounded-full bg-amber-500 px-1.5 py-px text-[10px] font-medium text-white">
                                🔐 {permissions.length}
                            </span>
                        )}
                        {member.agentType && (
                            <span className="shrink-0 rounded bg-[var(--app-border)] px-1 py-px text-[10px] text-[var(--app-hint)]">
                                {member.agentType}
                            </span>
                        )}
                        {member.isolation === 'worktree' && (
                            <span className="shrink-0 rounded bg-[var(--app-badge-warning-bg)] px-1 py-px text-[10px] text-[var(--app-badge-warning-text)]">
                                worktree
                            </span>
                        )}
                        {member.runInBackground && (
                            <span className="shrink-0 rounded bg-[var(--app-badge-success-bg)] px-1 py-px text-[10px] text-[var(--app-badge-success-text)]">
                                bg
                            </span>
                        )}
                    </div>
                    {member.description && (
                        <div className="mt-0.5 truncate text-[10px] leading-tight text-[var(--app-hint)]">
                            {member.description}
                        </div>
                    )}
                </div>
                <span className="shrink-0 text-[10px] text-[var(--app-hint)]">
                    {memberStatusLabel(member.status)}
                </span>
                {/* Expand indicator */}
                <svg
                    className={`h-3 w-3 shrink-0 text-[var(--app-hint)] transition-transform ${shouldExpand ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                >
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </button>

            {shouldExpand && (
                <div className="border-t border-[var(--app-border)] px-2.5 py-2">
                    {/* Pending permissions */}
                    {permissions.map(perm => (
                        <PermissionCard
                            key={perm.requestId}
                            permission={perm}
                            onApprove={() => onApprovePermission?.(perm)}
                            onDeny={() => onDenyPermission?.(perm)}
                        />
                    ))}

                    {activity?.toolCalls?.[0]?.description && (
                        <div className={`${permissions.length > 0 ? 'mt-1.5' : ''} text-[11px] text-[var(--app-fg)]`}>
                            <span className="font-medium">Task:</span> {activity.toolCalls[0].description}
                        </div>
                    )}
                    {(() => {
                        // Prefer real-time lastOutput from TeamState, fallback to activity extraction
                        const output = member.lastOutput ?? activity?.lastOutput
                        if (output) {
                            return (
                                <div className="mt-1 max-h-40 overflow-y-auto">
                                    <pre className="whitespace-pre-wrap break-words text-[10px] leading-relaxed text-[var(--app-hint)]">
                                        {output}
                                    </pre>
                                </div>
                            )
                        }
                        if (!hasPendingPerms) {
                            return (
                                <div className="text-[10px] text-[var(--app-hint)]">
                                    {isActive ? 'Working...' : 'No output yet'}
                                </div>
                            )
                        }
                        return null
                    })()}
                </div>
            )}
        </div>
    )
}

function TaskItem({ task }: { task: TeamTask }) {
    return (
        <div className="flex items-start gap-1.5 text-xs">
            <span className={`mt-px shrink-0 ${taskStatusClass(task.status)}`}>
                {taskStatusIcon(task.status)}
            </span>
            <span className={task.status === 'completed' ? 'text-[var(--app-hint)] line-through' : 'text-[var(--app-fg)]'}>
                {task.title}
            </span>
            {task.owner && (
                <span className="ml-auto shrink-0 text-[var(--app-hint)]">
                    {task.owner}
                </span>
            )}
        </div>
    )
}

function MessageItem({ msg }: { msg: TeamMessage }) {
    const time = new Date(msg.timestamp)
    const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`

    const typeIcon = msg.type === 'broadcast' ? '\uD83D\uDCE2'
        : msg.type === 'shutdown_request' ? '\u26D4'
        : msg.type === 'shutdown_response' ? '\u2705'
        : '\uD83D\uDCAC'

    return (
        <div className="flex items-start gap-1.5 text-xs">
            <span className="shrink-0 text-[10px] text-[var(--app-hint)]">{timeStr}</span>
            <span className="shrink-0">{typeIcon}</span>
            <div className="min-w-0">
                <span className="font-medium text-[var(--app-fg)]">{msg.from}</span>
                <span className="text-[var(--app-hint)]"> → </span>
                <span className="font-medium text-[var(--app-fg)]">{msg.to}</span>
                {msg.summary && (
                    <span className="text-[var(--app-hint)]">: {msg.summary}</span>
                )}
            </div>
        </div>
    )
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0
    return (
        <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
                <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-300"
                    style={{ width: `${pct}%` }}
                />
            </div>
            <span className="shrink-0 text-[10px] text-[var(--app-hint)]">
                {completed}/{total}
            </span>
        </div>
    )
}

export function TeamPanel(props: {
    teamState: TeamState
    messages?: DecryptedMessage[]
    api?: ApiClient
    sessionId?: string
    onSend?: (text: string) => void
}) {
    const { teamState, messages: conversationMessages } = props
    const members = teamState.members ?? []
    const tasks = teamState.tasks ?? []
    const messages = teamState.messages ?? []
    const pendingPermissions = (teamState.pendingPermissions ?? []).filter(p => p.status === 'pending')

    const activeMembers = members.filter(m => m.status === 'active').length
    const completedTasks = tasks.filter(t => t.status === 'completed').length
    const hasActivity = activeMembers > 0 || tasks.some(t => t.status === 'in_progress')
    const totalPendingPerms = pendingPermissions.length

    const activities = useMemo(
        () => conversationMessages ? extractTeammateActivities(conversationMessages) : new Map<string, TeammateActivity>(),
        [conversationMessages]
    )

    const memberPermissions = useMemo(() => {
        const map = new Map<string, TeamPermission[]>()
        for (const perm of pendingPermissions) {
            const existing = map.get(perm.memberName) ?? []
            existing.push(perm)
            map.set(perm.memberName, existing)
        }
        return map
    }, [pendingPermissions])

    const handleApprovePermission = async (perm: TeamPermission) => {
        // Use toolUseId (which matches agentState.requests) if available, fallback to requestId
        const permId = perm.toolUseId ?? perm.requestId
        if (props.api && props.sessionId) {
            try {
                await props.api.approvePermission(props.sessionId, permId)
                return
            } catch {
                // API failed (e.g. request not found in agentState.requests),
                // fall back to sending text message to the lead
            }
        }
        props.onSend?.(`Approve ${perm.memberName}'s permission request to use ${perm.toolName}. Request ID: ${perm.requestId}`)
    }

    const handleDenyPermission = async (perm: TeamPermission) => {
        const permId = perm.toolUseId ?? perm.requestId
        if (props.api && props.sessionId) {
            try {
                await props.api.denyPermission(props.sessionId, permId)
                return
            } catch {
                // Fall back to text message
            }
        }
        props.onSend?.(`Deny ${perm.memberName}'s permission request to use ${perm.toolName}. Request ID: ${perm.requestId}`)
    }

    // Default expanded when there's active work or pending permissions
    const [expanded, setExpanded] = useState(hasActivity || totalPendingPerms > 0)

    return (
        <div className="mx-3 mt-3 shrink-0">
            <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="flex w-full items-center gap-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
            >
                {/* Team icon */}
                <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                    <circle cx="9" cy="7" r="4" />
                    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>

                <span className="font-medium text-[var(--app-fg)]">
                    {teamState.teamName}
                </span>

                {/* Activity indicator */}
                {hasActivity && (
                    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                )}

                {/* Summary badges */}
                <div className="flex items-center gap-1.5 text-[10px] text-[var(--app-hint)]">
                    {members.length > 0 && (
                        <span className="rounded bg-[var(--app-subtle-bg)] px-1 py-px">
                            {activeMembers}/{members.length} agents
                        </span>
                    )}
                    {tasks.length > 0 && (
                        <span className="rounded bg-[var(--app-subtle-bg)] px-1 py-px">
                            {completedTasks}/{tasks.length} tasks
                        </span>
                    )}
                    {totalPendingPerms > 0 && (
                        <span className="animate-pulse rounded-full bg-amber-500 px-1.5 py-px font-medium text-white">
                            🔐 {totalPendingPerms} pending
                        </span>
                    )}
                </div>

                {/* Expand chevron */}
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
                <div className="mt-1 max-h-[min(40vh,300px)] space-y-2 overflow-y-auto overscroll-contain rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2.5">
                    {teamState.description && (
                        <p className="text-xs text-[var(--app-hint)]">{teamState.description}</p>
                    )}

                    {/* Members - now expandable with activity */}
                    {members.length > 0 && (
                        <div>
                            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--app-hint)]">
                                Agents ({activeMembers} active) — click to expand
                            </div>
                            <div className="flex flex-col gap-1">
                                {members.map((member) => (
                                    <MemberCard
                                        key={member.name}
                                        member={member}
                                        activity={activities.get(member.name)}
                                        permissions={memberPermissions.get(member.name) ?? []}
                                        onApprovePermission={handleApprovePermission}
                                        onDenyPermission={handleDenyPermission}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Tasks with progress */}
                    {tasks.length > 0 && (
                        <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--app-hint)]">
                                Tasks
                            </div>
                            <ProgressBar completed={completedTasks} total={tasks.length} />
                            <div className="mt-1.5 flex flex-col gap-1">
                                {tasks.map((task, idx) => (
                                    <TaskItem key={task.id ?? String(idx)} task={task} />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Messages */}
                    {messages.length > 0 && (
                        <div>
                            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--app-hint)]">
                                Messages
                            </div>
                            <div className="flex flex-col gap-1">
                                {messages.slice(-8).map((msg, idx) => (
                                    <MessageItem key={idx} msg={msg} />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
