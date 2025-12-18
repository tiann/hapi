import { useMemo, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { usePlatform } from '@/hooks/usePlatform'

function getMachineTitle(machine: Machine | null): string {
    if (!machine) return 'Machine'
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

export function SpawnSession(props: {
    api: ApiClient
    machineId: string
    machine: Machine | null
    onSuccess: (sessionId: string) => void
    onCancel: () => void
}) {
    const { haptic } = usePlatform()
    const [directory, setDirectory] = useState('')
    const [isWorking, setIsWorking] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const machineTitle = useMemo(() => getMachineTitle(props.machine), [props.machine])

    async function spawn() {
        const trimmed = directory.trim()
        if (!trimmed) return

        setIsWorking(true)
        setError(null)
        try {
            const result = await props.api.spawnSession(props.machineId, trimmed)
            if (result.type === 'success') {
                haptic.notification('success')
                props.onSuccess(result.sessionId)
                return
            }
            haptic.notification('error')
            setError(result.message)
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : 'Failed to spawn session')
        } finally {
            setIsWorking(false)
        }
    }

    return (
        <div className="p-3">
            <Card>
                <CardHeader className="pb-2">
                    <CardTitle>Create Session</CardTitle>
                    <CardDescription className="truncate">
                        {machineTitle}
                    </CardDescription>
                </CardHeader>
                <CardContent className="pt-0">
                    <div className="flex flex-col gap-3">
                        <input
                            type="text"
                            placeholder="/path/to/project"
                            value={directory}
                            onChange={(e) => setDirectory(e.target.value)}
                            className="w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                        />

                        {error ? (
                            <div className="text-sm text-red-600">
                                {error}
                            </div>
                        ) : null}

                        <div className="flex gap-2">
                            <Button
                                variant="secondary"
                                onClick={props.onCancel}
                                disabled={isWorking}
                            >
                                Cancel
                            </Button>
                            <Button
                                onClick={spawn}
                                disabled={isWorking || !directory.trim()}
                            >
                                {isWorking ? 'Creating…' : 'Create Session'}
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}
