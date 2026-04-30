import { useCallback } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useMachines } from '@/hooks/queries/useMachines'
import { DialogContent, DialogTitle, DialogHeader, DialogDescription } from '@/components/ui/dialog'
import { WorkspaceBrowser } from '@/components/WorkspaceBrowser'

export function BrowserModal(props: { machineId?: string; onClose: () => void }) {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { t } = useTranslation()

    const handleStartSession = useCallback((machineId: string, directory: string) => {
        void navigate({
            search: (prev: any) => ({
                ...prev,
                modal: 'new-session',
                modalPath: directory,
                modalMachineId: machineId
            })
        } as any)
    }, [navigate])

    return (
        <DialogContent className="flex flex-col max-h-[85vh] w-[95vw] max-w-2xl p-0 gap-0 overflow-hidden">
            <DialogHeader className="p-4 pb-3 border-b border-[var(--app-border)]">
                <DialogTitle className="text-xl font-semibold">{t('browse.title')}</DialogTitle>
                <DialogDescription className="sr-only">Browse workspaces</DialogDescription>
            </DialogHeader>

            <div className="app-scroll-y p-4 min-h-[400px]">
                <WorkspaceBrowser
                    api={api}
                    machines={machines}
                    machinesLoading={machinesLoading}
                    onStartSession={handleStartSession}
                    initialMachineId={props.machineId}
                />
            </div>
        </DialogContent>
    )
}
