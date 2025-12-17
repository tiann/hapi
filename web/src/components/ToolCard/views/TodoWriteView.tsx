import type { ToolViewProps } from '@/components/ToolCard/views/_all'

type TodoItem = {
    id?: string
    content?: string
    status?: 'pending' | 'in_progress' | 'completed'
    priority?: 'high' | 'medium' | 'low'
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function extractTodos(input: unknown, result: unknown): TodoItem[] {
    const todosFromInput = isObject(input) && Array.isArray(input.todos)
        ? input.todos.filter(isObject)
        : []
    if (todosFromInput.length > 0) {
        return todosFromInput.map((t) => ({
            id: typeof t.id === 'string' ? t.id : undefined,
            content: typeof t.content === 'string' ? t.content : undefined,
            status: t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed' ? t.status : undefined,
            priority: t.priority === 'high' || t.priority === 'medium' || t.priority === 'low' ? t.priority : undefined
        }))
    }

    const newTodos = isObject(result) && Array.isArray(result.newTodos)
        ? result.newTodos.filter(isObject)
        : []
    return newTodos.map((t) => ({
        id: typeof t.id === 'string' ? t.id : undefined,
        content: typeof t.content === 'string' ? t.content : undefined,
        status: t.status === 'pending' || t.status === 'in_progress' || t.status === 'completed' ? t.status : undefined,
        priority: t.priority === 'high' || t.priority === 'medium' || t.priority === 'low' ? t.priority : undefined
    }))
}

function todoTone(todo: TodoItem): string {
    if (todo.status === 'completed') return 'text-emerald-600 line-through'
    if (todo.status === 'in_progress') return 'text-[var(--app-link)]'
    return 'text-[var(--app-hint)]'
}

function todoIcon(todo: TodoItem): string {
    if (todo.status === 'completed') return '☑'
    return '☐'
}

export function TodoWriteView(props: ToolViewProps) {
    const todos = extractTodos(props.block.tool.input, props.block.tool.result)
    if (todos.length === 0) return null

    return (
        <div className="flex flex-col gap-1">
            {todos.map((todo, idx) => {
                const text = todo.content?.trim() ? todo.content.trim() : '(empty)'
                return (
                    <div key={todo.id ?? String(idx)} className={`text-sm ${todoTone(todo)}`}>
                        {todoIcon(todo)} {text}
                    </div>
                )
            })}
        </div>
    )
}

