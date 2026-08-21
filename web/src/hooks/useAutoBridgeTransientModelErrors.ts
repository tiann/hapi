import { useCallback, useEffect, useState } from 'react'
import {
    readAutoBridgeTransientModelErrors,
    writeAutoBridgeTransientModelErrors
} from '@/lib/modelErrorBridgePrefs'

export function useAutoBridgeTransientModelErrors(): {
    enabled: boolean
    setEnabled: (enabled: boolean) => void
} {
    const [enabled, setEnabledState] = useState(() => readAutoBridgeTransientModelErrors())

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            if (event.key === 'hapi-auto-bridge-transient-model-errors') {
                setEnabledState(readAutoBridgeTransientModelErrors())
            }
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setEnabled = useCallback((next: boolean) => {
        writeAutoBridgeTransientModelErrors(next)
        setEnabledState(next)
    }, [])

    return { enabled, setEnabled }
}
