import { useEffect, useMemo, useRef, useState } from 'react'
import type { TodoItem } from '@/types/api'

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
    return (
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 text-[var(--app-hint)] transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`}
        >
            <polyline points="6 9 12 15 18 9" />
        </svg>
    )
}

function todoColor(status: TodoItem['status']): string {
    if (status === 'in_progress') return 'text-[var(--app-link)]'
    return 'text-[var(--app-hint)]'
}

function getTodoSignature(todos: TodoItem[] | undefined): string {
    if (!todos || todos.length === 0) return ''
    return todos
        .map(t => `${t.id}\u0001${t.status}\u0001${t.content}`)
        .sort()
        .join('\u0002')
}

export function SessionTodoPanel({ todos }: { todos: TodoItem[] | undefined }) {
    const [isCollapsed, setIsCollapsed] = useState(false)

    const todoSignature = useMemo(() => getTodoSignature(todos), [todos])
    const prevTodoSignatureRef = useRef(todoSignature)

    const activeTodos = todos?.filter(t => t.status !== 'completed') ?? []
    const completedCount = (todos?.length ?? 0) - activeTodos.length
    const totalCount = todos?.length ?? 0
    const inProgressItem = activeTodos.find(t => t.status === 'in_progress')

    useEffect(() => {
        if (prevTodoSignatureRef.current !== todoSignature) {
            prevTodoSignatureRef.current = todoSignature
            if (activeTodos.length > 0) {
                setIsCollapsed(false)
            }
        }
    }, [todoSignature, activeTodos.length])

    if (totalCount === 0 || activeTodos.length === 0) return null

    const inProgressLabel = (inProgressItem?.content ?? '').trim()
    const summaryText = inProgressLabel
        ? `${completedCount}/${totalCount} \u00b7 ${inProgressLabel}`
        : `${completedCount}/${totalCount} tasks done`

    return (
        <div className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
            <div className="mx-auto w-full max-w-content">
                <button
                    type="button"
                    onClick={() => setIsCollapsed(c => !c)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left"
                    aria-expanded={!isCollapsed}
                >
                    <ChevronIcon collapsed={isCollapsed} />
                    {isCollapsed ? (
                        <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]">
                            {summaryText}
                        </span>
                    ) : (
                        <span className="flex-1 text-xs font-medium text-[var(--app-fg)]">
                            Tasks
                            <span className="ml-1.5 font-normal text-[var(--app-hint)]">
                                {completedCount}/{totalCount}
                            </span>
                        </span>
                    )}
                </button>

                <div className={`overflow-hidden transition-all duration-200 ${isCollapsed ? 'max-h-0' : 'max-h-[40vh] overflow-y-auto'}`}>
                    <div className="flex flex-col gap-1 px-3 pb-2">
                        {activeTodos.map((todo, idx) => (
                            <div
                                key={todo.id ?? idx}
                                className={`flex items-start gap-1.5 text-xs ${todoColor(todo.status)}`}
                            >
                                <span className="mt-px shrink-0 select-none">{'\u2610'}</span>
                                <span className="min-w-0 leading-snug">
                                    {todo.content?.trim() || '(empty)'}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}
