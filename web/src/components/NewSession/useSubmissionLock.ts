import { useCallback, useRef, useState } from 'react'

export type SubmissionRunResult<T> =
    | { started: false }
    | { started: true; value: T }

export function useSubmissionLock(): {
    isLocked: boolean
    run: <T>(operation: () => Promise<T>) => Promise<SubmissionRunResult<T>>
} {
    const lockedRef = useRef(false)
    const [isLocked, setIsLocked] = useState(false)

    const run = useCallback(async <T>(operation: () => Promise<T>): Promise<SubmissionRunResult<T>> => {
        if (lockedRef.current) return { started: false }

        lockedRef.current = true
        setIsLocked(true)
        try {
            return { started: true, value: await operation() }
        } finally {
            lockedRef.current = false
            setIsLocked(false)
        }
    }, [])

    return { isLocked, run }
}
