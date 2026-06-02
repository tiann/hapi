import { app, BrowserWindow, shell } from 'electron'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LauncherConfig } from '../shared'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIN_WINDOW_WIDTH = 860
const MIN_WINDOW_HEIGHT = 560
const DEFAULT_WINDOW_WIDTH = MIN_WINDOW_WIDTH
const DEFAULT_WINDOW_HEIGHT = MIN_WINDOW_HEIGHT

export function createMainWindow(config: LauncherConfig): BrowserWindow {
    const bounds = config.windowBounds
    const win = new BrowserWindow({
        width: normalizeWindowSize(bounds?.width, DEFAULT_WINDOW_WIDTH, MIN_WINDOW_WIDTH),
        height: normalizeWindowSize(bounds?.height, DEFAULT_WINDOW_HEIGHT, MIN_WINDOW_HEIGHT),
        x: bounds?.x,
        y: bounds?.y,
        minWidth: MIN_WINDOW_WIDTH,
        minHeight: MIN_WINDOW_HEIGHT,
        show: true,
        title: 'HAPI Desktop',
        icon: join(app.getAppPath(), 'assets', 'icon.png'),
        backgroundColor: '#f7f9fc',
        webPreferences: {
            preload: join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false
        }
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url)
        return { action: 'deny' }
    })

    const devServer = process.env.VITE_DEV_SERVER_URL
    if (devServer) {
        void win.loadURL(devServer)
    } else {
        void win.loadFile(resolve(__dirname, '../renderer/index.html'))
    }

    return win
}

function normalizeWindowSize(value: number | undefined, fallback: number, minimum: number): number {
    return Math.max(value ?? fallback, minimum)
}
