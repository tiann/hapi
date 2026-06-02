import { dialog, ipcMain, type BrowserWindow, type OpenDialogOptions } from 'electron'
import type { ConfigStore } from './configStore'
import type { ProcessManager } from './processManager'
import type { LauncherConfig } from '../shared'

export function registerIpc(configStore: ConfigStore, processManager: ProcessManager, getWindow: () => BrowserWindow | null): void {
    ipcMain.handle('config:get', async () => await configStore.read())
    ipcMain.handle('config:save', async (_event, config: LauncherConfig) => {
        const status = processManager.getState().status
        if (status !== 'stopped' && status !== 'error') {
            return await configStore.update((current) => ({
                ...current,
                locale: config.locale
            }))
        }
        return await configStore.write(config)
    })
    ipcMain.handle('state:get', () => processManager.getState())
    ipcMain.handle('service:start', async () => await processManager.start())
    ipcMain.handle('service:stop', async () => await processManager.stop())
    ipcMain.handle('web:open', async () => await processManager.openWeb())
    ipcMain.handle('logs:clear', () => {
        const win = getWindow()
        win?.webContents.send('logs:clear')
    })
    ipcMain.handle('dialog:choose-directory', async () => {
        const win = getWindow()
        const options: OpenDialogOptions = {
            properties: ['openDirectory']
        }
        const result = win
            ? await dialog.showOpenDialog(win, options)
            : await dialog.showOpenDialog(options)
        return result.canceled ? null : result.filePaths[0] ?? null
    })

    processManager.onState((state) => {
        getWindow()?.webContents.send('state:change', state)
    })
    processManager.onLog((entry) => {
        getWindow()?.webContents.send('logs:append', entry)
    })
}
