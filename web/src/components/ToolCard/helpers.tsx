/**
 * Shared helpers for Task tool child rendering.
 * Used by both ToolCard.tsx (summary) and trace.tsx (trace section).
 */
import React from 'react'
import type { ToolCallBlock } from '@/chat/types'
import type { SessionMetadataSummary } from '@/types/api'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { truncate } from '@/lib/toolInputUtils'

export function formatTaskChildLabel(
    child: ToolCallBlock,
    metadata: SessionMetadataSummary | null,
    t?: (key: string, params?: Record<string, string | number>) => string,
): string {
    const presentation = getToolPresentation({
        toolName: child.tool.name,
        input: child.tool.input,
        result: child.tool.result,
        childrenCount: child.children.length,
        description: child.tool.description,
        metadata,
    }, t)

    if (presentation.subtitle) {
        return truncate(`${presentation.title}: ${presentation.subtitle}`, 140)
    }

    return presentation.title
}

export function TaskStateIcon(props: { state: ToolCallBlock['tool']['state'] }): React.JSX.Element {
    if (props.state === 'completed') {
        return <span className="text-emerald-600">✓</span>
    }
    if (props.state === 'error') {
        return <span className="text-red-600">✕</span>
    }
    if (props.state === 'pending') {
        return <span className="text-amber-600">🔐</span>
    }
    return <span className="text-amber-600 animate-pulse">●</span>
}
