import { useCallback, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { useFeatures } from '@/hooks/queries/useFeatures'

export type SessionInputTranslation = {
    /** Hub has a provider, or this session is already on (so it can still be turned off). */
    visible: boolean
    /** Effective state: the session's explicit choice, else the hub-wide default. */
    enabled: boolean
    /** True when `enabled` comes from the hub default rather than a per-session choice. */
    fromDefault: boolean
    pending: boolean
    /** Writes an explicit per-session choice (the opposite of `enabled`); rejects on hub error. */
    toggle: () => Promise<void>
}

/** Effective input-translation state: explicit `metadata.translateInput` wins over the hub default. */
export function resolveInputTranslationEnabled(
    explicit: boolean | undefined,
    hubDefault: boolean
): { enabled: boolean; fromDefault: boolean } {
    if (typeof explicit === 'boolean') return { enabled: explicit, fromDefault: false }
    return { enabled: hubDefault, fromDefault: true }
}

export function useSessionInputTranslation(
    api: ApiClient | null,
    session: Pick<Session, 'id' | 'metadata'> | null
): SessionInputTranslation {
    const queryClient = useQueryClient()
    const { features } = useFeatures(api)
    const available = features?.inputTranslation?.available === true
    const hubSettingsQuery = useQuery({
        queryKey: queryKeys.hubSettings,
        queryFn: async () => {
            if (!api) throw new Error('API unavailable')
            return await api.getHubSettings()
        },
        enabled: Boolean(api) && available,
        staleTime: 30_000,
        retry: false,
    })
    const hubDefault = available && hubSettingsQuery.data?.translateInputByDefault === true
    const explicit = session?.metadata?.translateInput
    const { enabled, fromDefault } = resolveInputTranslationEnabled(explicit, hubDefault)
    const [pending, setPending] = useState(false)
    const sessionId = session?.id ?? null

    const toggle = useCallback(async () => {
        if (!api || !sessionId || pending) return
        const next = !enabled
        const key = queryKeys.session(sessionId)
        const previous = queryClient.getQueryData<{ session: Session }>(key)
        // Optimistic: SSE `session-updated` reconciles with the hub shortly after.
        if (previous?.session.metadata) {
            queryClient.setQueryData<{ session: Session }>(key, {
                ...previous,
                session: {
                    ...previous.session,
                    metadata: { ...previous.session.metadata, translateInput: next }
                }
            })
        }
        setPending(true)
        try {
            await api.setSessionTranslateInput(sessionId, next)
        } catch (error) {
            if (previous) queryClient.setQueryData(key, previous)
            throw error
        } finally {
            setPending(false)
            void queryClient.invalidateQueries({ queryKey: key })
        }
    }, [api, enabled, pending, queryClient, sessionId])

    return {
        visible: Boolean(api) && (available || enabled),
        enabled,
        fromDefault,
        pending,
        toggle,
    }
}
