import { useCallback } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { DialogContent, DialogTitle, DialogHeader, DialogDescription } from '@/components/ui/dialog'
import { WorkspaceBrowser } from '@/components/WorkspaceBrowser'
import type { RootSearch } from '@/router'

export function BrowserModal(props: { machineId?: string; initialPath?: string; onClose: () => void }) {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const search = useSearch({ strict: false }) as RootSearch
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { t } = useTranslation()

    const handleStartSession = useCallback((machineId: string, directory: string) => {
        if (search.modalReturnTo === 'editor') {
            void navigate({
                to: '/editor',
                search: { machine: machineId, project: directory },
                replace: true
            })
            return
        }

        void navigate({
            search: (prev: any) => ({
                ...prev,
                modal: 'new-session',
                modalPath: directory,
                modalMachineId: machineId,
                modalReturnTo: search.modalReturnTo
            })
        } as any)
    }, [navigate, search.modalReturnTo])

    return (
        <DialogContent className="flex h-[85vh] max-h-[85vh] w-[95vw] max-w-2xl flex-col gap-0 overflow-hidden p-0">
            <DialogHeader className="p-4 pb-3 border-b border-[var(--app-border)]">
                <DialogTitle className="text-xl font-semibold">
                    {search.modalReturnTo === 'editor' ? 'Open project folder' : t('browse.title')}
                </DialogTitle>
                <DialogDescription className="sr-only">Browse workspaces</DialogDescription>
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-hidden p-4">
                <WorkspaceBrowser
                    api={api}
                    machines={machines}
                    machinesLoading={machinesLoading}
                    onStartSession={handleStartSession}
                    initialMachineId={props.machineId}
                    initialPath={props.initialPath}
                    actionLabel={search.modalReturnTo === 'editor' ? 'Open Folder' : undefined}
                />
            </div>
        </DialogContent>
    )
}
