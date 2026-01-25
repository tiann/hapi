import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

interface PWAUpdateContextValue {
    version: {
        sha: string
        shortSha: string
        buildTime: string
        isDirty: boolean
        gitDescribe: string
    }
    checkForUpdate: () => Promise<void>
    forceReload: () => void
    isChecking: boolean
}

const PWAUpdateContext = createContext<PWAUpdateContextValue | null>(null)

interface PWAUpdateProviderProps {
    children: ReactNode
}

export function PWAUpdateProvider({ children }: PWAUpdateProviderProps) {
    const [version, setVersion] = useState({
        sha: 'unknown',
        shortSha: 'unknown',
        buildTime: 'unknown',
        isDirty: false,
        gitDescribe: 'unknown'
    })
    const [isChecking, setIsChecking] = useState(false)

    useEffect(() => {
        // Get version from HTML meta tags
        const versionMeta = document.querySelector('meta[name="app-version"]')
        const shortVersionMeta = document.querySelector('meta[name="app-version-short"]')
        const buildTimeMeta = document.querySelector('meta[name="app-build-time"]')
        const dirtyMeta = document.querySelector('meta[name="app-version-dirty"]')
        const describeMeta = document.querySelector('meta[name="app-version-describe"]')

        if (versionMeta && shortVersionMeta && buildTimeMeta) {
            setVersion({
                sha: versionMeta.getAttribute('content') || 'unknown',
                shortSha: shortVersionMeta.getAttribute('content') || 'unknown',
                buildTime: buildTimeMeta.getAttribute('content') || 'unknown',
                isDirty: dirtyMeta?.getAttribute('content') === 'true',
                gitDescribe: describeMeta?.getAttribute('content') || 'unknown'
            })
        }
    }, [])

    const checkForUpdate = async () => {
        setIsChecking(true)
        try {
            if ('serviceWorker' in navigator) {
                const registration = await navigator.serviceWorker.getRegistration()
                if (registration) {
                    await registration.update()
                    // Give it a moment to install new SW
                    await new Promise(resolve => setTimeout(resolve, 1000))
                }
            }
        } finally {
            setIsChecking(false)
        }
    }

    const forceReload = () => {
        // Unregister service worker and hard reload
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(registrations => {
                for (const registration of registrations) {
                    registration.unregister()
                }
                window.location.reload()
            })
        } else {
            window.location.reload()
        }
    }

    const value: PWAUpdateContextValue = {
        version,
        checkForUpdate,
        forceReload,
        isChecking
    }

    return (
        <PWAUpdateContext.Provider value={value}>
            {children}
        </PWAUpdateContext.Provider>
    )
}

export function usePWAUpdate() {
    const context = useContext(PWAUpdateContext)
    if (!context) {
        throw new Error('usePWAUpdate must be used within PWAUpdateProvider')
    }
    return context
}
