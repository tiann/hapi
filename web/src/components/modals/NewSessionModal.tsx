import { useCallback } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { queryKeys } from '@/lib/query-keys'
import { DialogContent, DialogTitle, DialogHeader, DialogDescription } from '@/components/ui/dialog'
import { NewSession } from '@/components/NewSession'
import type { RootSearch } from '@/router'

export function NewSessionModal(props: { onClose: () => void }) {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const { machines, isLoading: machinesLoading, error: machinesError } = useMachines(api, true)
    const { t } = useTranslation()
    const search = useSearch({ strict: false }) as RootSearch
    const initialDirectory = search.modalPath
    const initialMachineId = search.modalMachineId

    const handleSuccess = useCallback((sessionId: string) => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })

        if (search.modalReturnTo === 'editor') {
            void navigate({
                search: (prev: any) => {
                    const newSearch = { ...prev }
                    delete newSearch.modal
                    delete newSearch.modalSessionId
                    delete newSearch.modalPath
                    delete newSearch.modalMachineId
                    delete newSearch.modalReplaceSessionId
                    delete newSearch.modalReturnTo
                    return { ...newSearch, modalNewSessionId: sessionId }
                },
                replace: true
            } as any)
            return
        }
        
        // Always read pins from localStorage (source of truth when dashboard is not active)
        let currentPins: string[] = []
        try {
            const saved = localStorage.getItem('mc-pinned-ids')
            if (saved) currentPins = JSON.parse(saved)
        } catch { /* ignore */ }
        // Also check URL params as secondary fallback
        if (currentPins.length === 0 && typeof (search as any).pins === 'string' && (search as any).pins) {
            currentPins = (search as any).pins.split(',')
        }

        const replaceSessionId = search.modalReplaceSessionId

        if (replaceSessionId) {
            // Replace in pins if pinned, otherwise just remove old and add new
            let newPins: string[]
            if (currentPins.includes(replaceSessionId)) {
                newPins = currentPins.map(id => id === replaceSessionId ? sessionId : id)
            } else if (currentPins.length < 4) {
                // Not pinned but room available — just auto-pin the new one
                newPins = Array.from(new Set([...currentPins, sessionId]))
            } else {
                // Not pinned, pins full — replace the replaceSessionId if it's there, else first slot
                // As fallback, just navigate to replace-pin modal
                void navigate({
                    search: (prev: any) => {
                        const newSearch = { ...prev }
                        delete newSearch.modalPath
                        delete newSearch.modalMachineId
                        delete newSearch.modalReplaceSessionId
                        delete newSearch.modalReturnTo
                        return { ...newSearch, modal: 'replace-pin', modalSessionId: sessionId }
                    },
                    replace: true
                } as any)
                return
            }
            void navigate({
                to: '/sessions',
                search: (prev: any) => {
                    const newSearch = { ...prev }
                    delete newSearch.modal
                    delete newSearch.modalSessionId
                    delete newSearch.modalPath
                    delete newSearch.modalMachineId
                    delete newSearch.modalReplaceSessionId
                    delete newSearch.modalReturnTo
                    return { ...newSearch, pins: newPins.join(','), modalNewSessionId: sessionId }
                },
                replace: true
            })
            return
        }

        if (currentPins.length < 4) {
            // Auto append
            const newPins = Array.from(new Set([...currentPins, sessionId]))
            void navigate({
                to: '/sessions',
                search: (prev: any) => {
                    const newSearch = { ...prev }
                    delete newSearch.modal
                    delete newSearch.modalSessionId
                    delete newSearch.modalPath
                    delete newSearch.modalMachineId
                    delete newSearch.modalReplaceSessionId
                    delete newSearch.modalReturnTo
                    return { ...newSearch, pins: newPins.join(','), modalNewSessionId: sessionId }
                },
                replace: true
            })
            return
        }

        // 4 pins already, need to open replace pin modal
        void navigate({
            search: (prev: any) => {
                const newSearch = { ...prev }
                delete newSearch.modalPath
                delete newSearch.modalMachineId
                delete newSearch.modalReplaceSessionId
                delete newSearch.modalReturnTo
                return { ...newSearch, modal: 'replace-pin', modalSessionId: sessionId }
            },
            replace: true
        } as any)
    }, [navigate, queryClient, search])

    const handleChooseFolder = useCallback((args: { machineId: string | null; directory: string }) => {
        void navigate({
            search: (prev: any) => ({
                ...prev,
                modal: 'browser',
                modalMachineId: args.machineId,
                modalReturnTo: search.modalReturnTo
            })
        } as any)
    }, [navigate, search.modalReturnTo])

    return (
        <DialogContent className="flex flex-col max-h-[85vh] w-[95vw] max-w-2xl p-0 gap-0 overflow-hidden">
            <DialogHeader className="p-4 pb-3 border-b border-[var(--app-border)]">
                <DialogTitle className="text-xl font-semibold">{t('newSession.title')}</DialogTitle>
                <DialogDescription className="sr-only">Create a new session</DialogDescription>
            </DialogHeader>

            <div className="app-scroll-y p-4">
                {machinesError ? (
                    <div className="mb-3 p-3 text-sm text-red-600 rounded bg-red-50">
                        {machinesError}
                    </div>
                ) : null}

                <NewSession
                    api={api}
                    machines={machines}
                    isLoading={machinesLoading}
                    onCancel={props.onClose}
                    onSuccess={handleSuccess}
                    onChooseFolder={handleChooseFolder}
                    initialDirectory={initialDirectory}
                    initialMachineId={initialMachineId}
                />
            </div>
        </DialogContent>
    )
}
