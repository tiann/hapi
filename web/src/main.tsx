import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'
import { registerSW } from 'virtual:pwa-register'

const updateSW = registerSW({
    onNeedRefresh() {
        if (confirm('New version available! Reload to update?')) {
            updateSW(true)
        }
    },
    onOfflineReady() {
        console.log('App ready for offline use')
    },
    onRegistered(registration) {
        if (registration) {
            setInterval(() => {
                registration.update()
            }, 60 * 60 * 1000)
        }
    },
    onRegisterError(error) {
        console.error('SW registration error:', error)
    }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
)
