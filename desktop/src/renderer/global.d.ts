import type { DesktopApi } from '../shared'

declare module '*.png' {
    const value: string
    export default value
}

declare global {
    interface Window {
        hapiDesktop: DesktopApi
    }
}

export {}
