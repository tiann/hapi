import { useSearch } from '@tanstack/react-router'
import { EditorLayout } from '@/components/editor/EditorLayout'
import { useAppContext } from '@/lib/app-context'
import { loadPersistedEditorState } from '@/lib/editor-persistence'

type EditorSearch = {
    machine?: string
    project?: string
}

export default function EditorPage() {
    const { api } = useAppContext()
    const search = useSearch({ strict: false }) as EditorSearch

    const persistedState = search.machine || search.project ? null : loadPersistedEditorState()

    return (
        <EditorLayout
            api={api}
            initialMachineId={search.machine}
            initialProjectPath={search.project}
            initialState={persistedState ?? undefined}
        />
    )
}
