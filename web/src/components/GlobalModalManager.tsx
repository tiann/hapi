import { useRouter, useSearch } from '@tanstack/react-router'
import { Dialog } from '@/components/ui/dialog'
import type { RootSearch } from '@/router'
import { SettingsModal } from '@/components/modals/SettingsModal'
import { NewSessionModal } from '@/components/modals/NewSessionModal'
import { FilesModal } from '@/components/modals/FilesModal'
import { TerminalModal } from '@/components/modals/TerminalModal'
import { BrowserModal } from '@/components/modals/BrowserModal'
import { ReplacePinModal } from '@/components/modals/ReplacePinModal'

export function GlobalModalManager() {
    const search = useSearch({ strict: false }) as RootSearch
    const router = useRouter()
    const { modal, modalSessionId, modalPath, modalMachineId } = search

    const handleClose = () => {
        void router.navigate({
            search: (prev: any) => {
                const newSearch = { ...prev }
                delete newSearch.modal
                delete newSearch.modalSessionId
                delete newSearch.modalPath
                delete newSearch.modalMachineId
                delete newSearch.modalReturnTo
                return newSearch
            },
            replace: true
        } as any)
    }

    if (!modal) return null

    return (
        <Dialog open={!!modal} onOpenChange={(open) => !open && handleClose()}>
            {modal === 'settings' && <SettingsModal onClose={handleClose} />}
            {modal === 'new-session' && <NewSessionModal onClose={handleClose} />}
            {modal === 'files' && <FilesModal sessionId={modalSessionId!} path={modalPath} onClose={handleClose} />}
            {modal === 'terminal' && <TerminalModal sessionId={modalSessionId!} onClose={handleClose} />}
            {modal === 'browser' && <BrowserModal machineId={modalMachineId} initialPath={modalPath} onClose={handleClose} />}
            {modal === 'replace-pin' && <ReplacePinModal onClose={handleClose} />}
        </Dialog>
    )
}
