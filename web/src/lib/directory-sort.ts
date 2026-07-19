import type { DirectoryEntry } from '@/types/api'
import type { Locale } from '@/lib/use-translation'

export type DirectorySortField = 'name' | 'modified' | 'size'
export type DirectorySortDirection = 'asc' | 'desc'
export type DirectorySort = { field: DirectorySortField; direction: DirectorySortDirection }

export const DEFAULT_DIRECTORY_SORT: DirectorySort = { field: 'name', direction: 'asc' }

function compareOptionalNumbers(left: number | undefined, right: number | undefined, direction: DirectorySortDirection): number {
    const leftMissing = left === undefined || !Number.isFinite(left)
    const rightMissing = right === undefined || !Number.isFinite(right)
    if (leftMissing && rightMissing) return 0
    if (leftMissing) return 1
    if (rightMissing) return -1
    return direction === 'asc' ? left - right : right - left
}

export function sortDirectoryEntries(
    entries: DirectoryEntry[],
    sort: DirectorySort,
    locale: Locale,
): DirectoryEntry[] {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
    const byName = (left: DirectoryEntry, right: DirectoryEntry, direction: DirectorySortDirection) => {
        const result = collator.compare(left.name, right.name)
        return direction === 'asc' ? result : -result
    }

    return [...entries].sort((left, right) => {
        const leftDirectory = left.type === 'directory'
        const rightDirectory = right.type === 'directory'
        if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1

        if (sort.field === 'name') return byName(left, right, sort.direction)
        if (sort.field === 'size' && leftDirectory) return byName(left, right, 'asc')

        const result = compareOptionalNumbers(left[sort.field], right[sort.field], sort.direction)
        return result || byName(left, right, 'asc')
    })
}
