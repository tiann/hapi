import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { ModelMode, PermissionMode } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'
import { clearMessageWindow } from '@/lib/message-window-store'
import { useSimpleToast } from '@/lib/simple-toast'
import { useTranslation } from '@/lib/use-translation'

export function useSessionActions(
    api: ApiClient | null,
    sessionId: string | null,
    agentFlavor?: string | null
): {
    abortSession: () => Promise<void>
    archiveSession: () => Promise<void>
    resumeSession: () => Promise<void>
    forkSession: () => Promise<void>
    reloadSession: (force?: boolean) => Promise<void>
    switchSession: () => Promise<void>
    setPermissionMode: (mode: PermissionMode) => Promise<void>
    setModelMode: (mode: ModelMode) => Promise<void>
    renameSession: (name: string) => Promise<void>
    deleteSession: () => Promise<void>
    isPending: boolean
} {
    const queryClient = useQueryClient()
    const navigate = useNavigate()
    const toast = useSimpleToast()
    const { t } = useTranslation()

    const invalidateSession = async () => {
        if (!sessionId) return
        await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
    }

    const abortMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.abortSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const archiveMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.archiveSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const handleResume = async () => {
        if (!api || !sessionId) {
            throw new Error('Session unavailable')
        }

        try {
            // Invalidate queries BEFORE navigation to ensure fresh data on session page
            await invalidateSession()

            // Trigger resume on server (spawns CLI process with --resume)
            await api.resumeSession(sessionId)

            // Navigate to session - let the session view handle its own message loading
            // The useMessages hook will fetch messages on mount, and SSE will provide real-time updates
            navigate({ to: '/sessions/$sessionId', params: { sessionId } })

            // Note: No success toast - navigation IS the success feedback
        } catch (error) {
            // Handle "already active" as success - just navigate to it
            // Use exact match to avoid misclassifying other 409 errors
            if (error instanceof Error && error.message === 'Session is already active') {
                navigate({ to: '/sessions/$sessionId', params: { sessionId } })
                return
            }

            // Handle session not found error with helpful guidance
            if (error instanceof Error && error.message.includes('SESSION_NOT_FOUND')) {
                toast.error(
                    t('dialog.resume.sessionNotFound', 'This session no longer exists. Please create a new session instead.'),
                    {
                        duration: 6000,  // Longer duration for important error
                    }
                )
                // Navigate to home to create new session
                navigate({ to: '/' })
                return
            }

            // Show error feedback for actual failures
            const message = error instanceof Error ? error.message : t('dialog.resume.error')
            toast.error(message)
            throw error // Re-throw so caller knows it failed
        }
    }

    const switchMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.switchSession(sessionId)
        },
        onSuccess: () => void invalidateSession(),
    })

    const permissionMutation = useMutation({
        mutationFn: async (mode: PermissionMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const isKnownFlavor = agentFlavor === 'claude' || agentFlavor === 'codex' || agentFlavor === 'gemini'
            if (isKnownFlavor && !isPermissionModeAllowedForFlavor(mode, agentFlavor)) {
                throw new Error('Invalid permission mode for session flavor')
            }
            await api.setPermissionMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const modelMutation = useMutation({
        mutationFn: async (mode: ModelMode) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.setModelMode(sessionId, mode)
        },
        onSuccess: () => void invalidateSession(),
    })

    const renameMutation = useMutation({
        mutationFn: async (name: string) => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.renameSession(sessionId, name)
        },
        onSuccess: () => void invalidateSession(),
    })

    const deleteMutation = useMutation({
        mutationFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            await api.deleteSession(sessionId)
        },
        onSuccess: async () => {
            if (!sessionId) return
            queryClient.removeQueries({ queryKey: queryKeys.session(sessionId) })
            clearMessageWindow(sessionId)
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        },
    })

    const handleFork = async (enableYolo: boolean = false) => {
        if (!api || !sessionId) {
            throw new Error('Session unavailable')
        }

        try {
            // Fork the session on the server
            const result = await api.forkSession(sessionId, enableYolo)

            // Invalidate sessions list to show the new forked session
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })

            // Show success message
            toast.success(t('dialog.fork.success', 'Session forked successfully'))

            // Navigate to the new forked session
            navigate({ to: '/sessions/$sessionId', params: { sessionId: result.id } })
        } catch (error) {
            const message = error instanceof Error ? error.message : t('dialog.fork.error', 'Failed to fork session')
            toast.error(message)
            throw error
        }
    }

    const handleReload = async (force: boolean = false, enableYolo: boolean = false) => {
        if (!api || !sessionId) {
            throw new Error('Session unavailable')
        }

        try {
            await api.reloadSession(sessionId, force, enableYolo)
            await invalidateSession()
            toast.success(t('dialog.reload.success', 'Session reloaded successfully'))
        } catch (error) {
            // Handle busy error
            if (error instanceof Error && error.message.includes('Session is busy')) {
                // Let the dialog handle force confirmation
                // Don't use window.confirm here as the dialog provides a better UX
            }

            const message = error instanceof Error ? error.message : t('dialog.reload.error', 'Failed to reload session')
            toast.error(message)
            throw error
        }
    }

    return {
        abortSession: abortMutation.mutateAsync,
        archiveSession: archiveMutation.mutateAsync,
        resumeSession: handleResume,
        forkSession: handleFork,
        reloadSession: handleReload,
        switchSession: switchMutation.mutateAsync,
        setPermissionMode: permissionMutation.mutateAsync,
        setModelMode: modelMutation.mutateAsync,
        renameSession: renameMutation.mutateAsync,
        deleteSession: deleteMutation.mutateAsync,
        isPending: abortMutation.isPending
            || archiveMutation.isPending
            || switchMutation.isPending
            || permissionMutation.isPending
            || modelMutation.isPending
            || renameMutation.isPending
            || deleteMutation.isPending,
    }
}
