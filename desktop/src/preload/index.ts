import { contextBridge, ipcRenderer } from 'electron'
import type { ConsoleLogEntry, DesktopApi, LauncherConfig, RuntimeState } from '../shared'

const api: DesktopApi = {
    getConfig: async () => await ipcRenderer.invoke('config:get') as LauncherConfig,
    saveConfig: async (config) => await ipcRenderer.invoke('config:save', config) as LauncherConfig,
    getState: async () => await ipcRenderer.invoke('state:get') as RuntimeState,
    start: async () => { await ipcRenderer.invoke('service:start') },
    stop: async () => { await ipcRenderer.invoke('service:stop') },
    openWeb: async () => { await ipcRenderer.invoke('web:open') },
    clearLogs: async () => { await ipcRenderer.invoke('logs:clear') },
    chooseDirectory: async () => await ipcRenderer.invoke('dialog:choose-directory') as string | null,
    onStateChange: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, state: RuntimeState) => callback(state)
        ipcRenderer.on('state:change', listener)
        return () => ipcRenderer.off('state:change', listener)
    },
    onLog: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, entry: ConsoleLogEntry) => callback(entry)
        ipcRenderer.on('logs:append', listener)
        return () => ipcRenderer.off('logs:append', listener)
    }
}

contextBridge.exposeInMainWorld('hapiDesktop', api)
