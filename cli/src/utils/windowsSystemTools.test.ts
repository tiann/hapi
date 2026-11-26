import { describe, expect, it } from 'vitest'
import { windowsSystemTool } from './windowsSystemTools'

describe('windowsSystemTool', () => {
    it('prefers SystemRoot over SYSTEMROOT and windir', () => {
        expect(windowsSystemTool('taskkill', { SystemRoot: 'D:\\OS', SYSTEMROOT: 'E:\\OS', windir: 'F:\\OS' }))
            .toBe('D:\\OS\\System32\\taskkill.exe')
    })

    it('uses SYSTEMROOT before windir', () => {
        expect(windowsSystemTool('tasklist', { SYSTEMROOT: 'E:\\OS', windir: 'F:\\OS' }))
            .toBe('E:\\OS\\System32\\tasklist.exe')
    })

    it('uses windir when both SystemRoot variants are absent', () => {
        expect(windowsSystemTool('where', { windir: 'F:\\OS' })).toBe('F:\\OS\\System32\\where.exe')
    })

    it('defaults to C:\\Windows and resolves the PowerShell and WMIC subdirectories', () => {
        expect(windowsSystemTool('powershell', {})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
        expect(windowsSystemTool('wmic', {})).toBe('C:\\Windows\\System32\\wbem\\WMIC.exe')
    })

    it('skips a relative or drive-relative root, which would resolve against the working directory', () => {
        expect(windowsSystemTool('taskkill', { SystemRoot: 'Windows', SYSTEMROOT: 'C:Windows', windir: 'D:\\OS' }))
            .toBe('D:\\OS\\System32\\taskkill.exe')
        expect(windowsSystemTool('taskkill', { SystemRoot: '.\\proj' })).toBe('C:\\Windows\\System32\\taskkill.exe')
    })
})
