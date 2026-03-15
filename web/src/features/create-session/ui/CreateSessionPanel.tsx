import { useState } from 'react'
import { useMachines } from '@/entities/machine'
import { useSpawnSession } from '@/entities/session'
import { NewSession } from '@/entities/session/ui'
import { useTranslation } from '@/lib/use-translation'
import type { ApiClient } from '@/api/client'

type CreateSessionPanelProps = {
    api: ApiClient | null
    onCreate: (sessionId: string) => void
}

export function CreateSessionPanel(props: CreateSessionPanelProps) {
    const { t } = useTranslation()
    const { api, onCreate } = props
    const { machines, isLoading: machinesLoading } = useMachines(api, true)
    const { spawnSession, isPending: isSpawning } = useSpawnSession(api)

    const handleCreate = async (params: {
        agentType: string
        machineId: string | null
        modelId: string | null
        directory: string
        yolo: boolean
    }) => {
        if (!params.machineId) {
            return
        }

        const result = await spawnSession({
            machineId: params.machineId,
            directory: params.directory,
            agent: params.agentType as 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode',
            model: params.modelId || undefined,
            yolo: params.yolo
        })

        if (result.type === 'success') {
            onCreate(result.sessionId)
        }
    }

    if (!api) {
        return (
            <div className="max-w-2xl mx-auto p-4">
                <div className="text-center text-[var(--app-hint)]">
                    {t('error.apiUnavailable')}
                </div>
            </div>
        )
    }

    return (
        <div className="max-w-2xl mx-auto p-4">
            <NewSession
                api={api}
                machines={machines}
                isLoading={machinesLoading}
                onSuccess={onCreate}
                onCancel={() => {}}
            />
        </div>
    )
}
