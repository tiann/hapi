export type SessionHeaderSecondaryMetadataKey =
    | 'model'
    | 'reasoning'
    | 'machine'
    | 'lastActive'
    | 'updatedAt'
    | 'createdAt'
    | 'worktree'
    | 'fastMode'

const MOBILE_SECONDARY_PRIORITY: ReadonlyArray<SessionHeaderSecondaryMetadataKey> = [
    'machine',
    'lastActive',
    'model',
    'reasoning',
    'fastMode',
    'createdAt',
    'updatedAt',
    'worktree',
]

export function selectMobileSessionHeaderSecondary(
    available: Partial<Record<SessionHeaderSecondaryMetadataKey, boolean>>
): SessionHeaderSecondaryMetadataKey | null {
    return getMobileSessionHeaderMetadata(available)[0] ?? null
}

export function getMobileSessionHeaderMetadata(
    available: Partial<Record<SessionHeaderSecondaryMetadataKey, boolean>>
): SessionHeaderSecondaryMetadataKey[] {
    return MOBILE_SECONDARY_PRIORITY.filter((key) => available[key] === true)
}
