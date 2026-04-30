import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useMachines } from '@/hooks/queries/useMachines'

type EditorProject = {
    path: string
    name: string
    hasGit: boolean
}

function getMachineLabel(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id.slice(0, 8)
}

export function EditorHeader(props: {
    api: ApiClient
    machineId: string | null
    projectPath: string | null
    onSelectMachine: (machineId: string) => void
    onSelectProject: (projectPath: string) => void
}) {
    const navigate = useNavigate()
    const { machines, isLoading: machinesLoading } = useMachines(props.api, true)
    const [projects, setProjects] = useState<EditorProject[]>([])
    const [projectsLoading, setProjectsLoading] = useState(false)

    useEffect(() => {
        let cancelled = false

        if (!props.machineId) {
            setProjects([])
            setProjectsLoading(false)
            return () => {
                cancelled = true
            }
        }

        setProjectsLoading(true)
        props.api.listEditorProjects(props.machineId)
            .then((response) => {
                if (cancelled) return
                if (response.success && response.projects) {
                    setProjects(response.projects)
                } else {
                    setProjects([])
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setProjects([])
                }
            })
            .finally(() => {
                if (!cancelled) {
                    setProjectsLoading(false)
                }
            })

        return () => {
            cancelled = true
        }
    }, [props.api, props.machineId])

    const handleMachineChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        props.onSelectMachine(event.target.value)
    }, [props])

    const handleProjectChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        props.onSelectProject(event.target.value)
    }, [props])

    return (
        <div className="flex items-center gap-3 px-4 py-2 border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)] shrink-0">
            <span className="font-semibold text-sm text-[var(--app-fg)] whitespace-nowrap">
                ⚡ HAPI Editor
            </span>

            <span className="text-[var(--app-hint)] text-xs">▸</span>

            <label className="sr-only" htmlFor="editor-machine-select">Machine</label>
            <select
                id="editor-machine-select"
                aria-label="Machine"
                value={props.machineId ?? ''}
                onChange={handleMachineChange}
                disabled={machinesLoading}
                className="bg-[var(--app-bg)] text-[var(--app-fg)] border border-[var(--app-border)] rounded-md px-2 py-1 text-xs min-w-0 max-w-[200px] truncate"
            >
                <option value="" disabled>{machinesLoading ? 'Loading...' : 'Select machine'}</option>
                {machines.map((machine) => (
                    <option key={machine.id} value={machine.id}>
                        🖥 {getMachineLabel(machine)}
                    </option>
                ))}
            </select>

            {props.machineId && (
                <>
                    <span className="text-[var(--app-hint)] text-xs">/</span>
                    <label className="sr-only" htmlFor="editor-project-select">Project</label>
                    <select
                        id="editor-project-select"
                        aria-label="Project"
                        value={props.projectPath ?? ''}
                        onChange={handleProjectChange}
                        disabled={projectsLoading}
                        className="bg-[var(--app-bg)] text-[var(--app-fg)] border border-[var(--app-border)] rounded-md px-2 py-1 text-xs min-w-0 max-w-[280px] truncate"
                    >
                        <option value="" disabled>{projectsLoading ? 'Loading...' : 'Select project'}</option>
                        {projects.map((project) => (
                            <option key={project.path} value={project.path}>
                                {project.hasGit ? '📁' : '📂'} {project.name}
                            </option>
                        ))}
                    </select>
                </>
            )}

            <span className="flex-1" />

            <button
                type="button"
                onClick={() => navigate({ to: '/sessions' })}
                className="px-3 py-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-fg)] text-xs hover:bg-[var(--app-subtle-bg)] transition-colors"
            >
                ← Agent Mode
            </button>
        </div>
    )
}
