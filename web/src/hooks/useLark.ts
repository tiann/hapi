export function isLarkEnvironment(): boolean {
    if (typeof navigator === 'undefined') return false
    return /Lark|Feishu/i.test(navigator.userAgent)
}

declare global {
    interface Window {
        h5sdk?: any
        tt?: any
    }
}

export function loadLarkSdk(): Promise<void> {
    return new Promise((resolve, reject) => {
        if (window.h5sdk || window.tt) {
            resolve()
            return
        }

        const script = document.createElement('script')
        // Using a stable version of Lark H5 JS SDK
        script.src = 'https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.23.js'
        script.async = true
        script.onload = () => resolve()
        script.onerror = (e) => reject(e)
        document.head.appendChild(script)
    })
}
