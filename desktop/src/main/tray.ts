import { Menu, Tray, type BrowserWindow, nativeImage, app } from 'electron'
import { join } from 'node:path'
import type { ProcessManager } from './processManager'

export function createTray(win: BrowserWindow, processManager: ProcessManager, requestQuit: () => void): Tray {
    const icon = nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'icon.png'))
    const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
    tray.setToolTip('HAPI Desktop')

    const showWindow = () => {
        if (win.isMinimized()) {
            win.restore()
        }
        win.show()
        win.focus()
    }

    const updateMenu = () => {
        const state = processManager.getState()
        const isRunning = state.status === 'running' || state.status === 'starting'
        const template = [
            { label: '显示窗口', click: showWindow },
            {
                label: isRunning ? '停止 HAPI' : '启动 HAPI',
                click: () => {
                    if (isRunning) {
                        void processManager.stop()
                    } else {
                        void processManager.start()
                    }
                }
            },
            { label: '打开 Web', click: () => void processManager.openWeb() },
            { type: 'separator' as const },
            {
                label: '退出',
                click: requestQuit
            }
        ]
        tray.setContextMenu(Menu.buildFromTemplate(template))
    }

    tray.on('double-click', showWindow)
    processManager.onState(updateMenu)
    updateMenu()
    return tray
}
