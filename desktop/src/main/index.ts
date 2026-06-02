import { app, BrowserWindow, Menu, type Tray } from 'electron'
import { ConfigStore } from './configStore'
import { registerIpc } from './ipc'
import { ProcessManager } from './processManager'
import { createTray } from './tray'
import { createMainWindow } from './window'

app.setName('HAPI Desktop')
app.setAppUserModelId('run.hapi.desktop')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let quitRequested = false
let processManager: ProcessManager | null = null

async function bootstrap(): Promise<void> {
    Menu.setApplicationMenu(null)

    const configStore = new ConfigStore()
    const config = await configStore.read()
    processManager = new ProcessManager(configStore)

    mainWindow = createMainWindow(config)
    registerIpc(configStore, processManager, () => mainWindow)
    tray = createTray(mainWindow, processManager, () => void requestQuit())

    mainWindow.on('close', (event) => {
        if (isQuitting) {
            return
        }
        event.preventDefault()
        mainWindow?.hide()
    })

    mainWindow.on('resize', () => void persistWindowBounds(configStore))
    mainWindow.on('move', () => void persistWindowBounds(configStore))

    app.on('before-quit', (event) => {
        if (!quitRequested) {
            event.preventDefault()
            void requestQuit()
            return
        }
        isQuitting = true
    })

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createMainWindow(config)
        } else {
            mainWindow?.show()
        }
    })

    void tray
}

async function requestQuit(): Promise<void> {
    if (quitRequested) {
        return
    }

    quitRequested = true
    isQuitting = true
    try {
        await processManager?.stop()
    } finally {
        app.quit()
    }
}

async function persistWindowBounds(configStore: ConfigStore): Promise<void> {
    const win = mainWindow
    if (!win) {
        return
    }
    const bounds = win.getBounds()
    await configStore.update((current) => ({
        ...current,
        windowBounds: {
            width: bounds.width,
            height: bounds.height,
            x: bounds.x,
            y: bounds.y
        }
    }))
}

app.whenReady().then(() => {
    void bootstrap()
}).catch((error) => {
    console.error(error)
})
