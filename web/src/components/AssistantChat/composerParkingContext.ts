import { createContext, useContext } from 'react'

/**
 * True while HappyComposer is awaiting a scratchlist park. Attachment chips
 * must not be removable mid-flight (would delete hub blobs the park still
 * references).
 */
export const ComposerParkingContext = createContext(false)

export function useComposerParking(): boolean {
    return useContext(ComposerParkingContext)
}
