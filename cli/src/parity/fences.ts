import type { Row } from './fakeHub'

export interface Fence {
    event: string
    contains?: string
    count?: number
    result?: string
}

export function reached(rows: Row[], fences: Fence | Fence[]) {
    return (Array.isArray(fences) ? fences : [fences]).every(fence => rows.filter(row =>
        row.event === fence.event && (!row.ackRequested || row.ack !== undefined) &&
        (!fence.contains || JSON.stringify(row.args).includes(fence.contains)) &&
        (!fence.result || (row.ack?.[0] as { result?: string })?.result === fence.result)
    ).length >= (fence.count ?? 1))
}
