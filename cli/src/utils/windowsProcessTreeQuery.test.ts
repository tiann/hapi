import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { windowsProcessTreeCimCommand } from './process'

// Execute the actual generated WinPS query against an in-memory CIM fixture.
// No process is signalled by this test.
describe.skipIf(process.platform !== 'win32')('Windows process-tree query', () => {
    it('uses one CIM enumeration across the Windows PID range and terminates on parent cycles', () => {
        const setup = `
$script:calls=0
$script:rows=@(
    [pscustomobject]@{ProcessId=100;ParentProcessId=300},
    [pscustomobject]@{ProcessId=200;ParentProcessId=100},
    [pscustomobject]@{ProcessId=300;ParentProcessId=200},
    [pscustomobject]@{ProcessId=[uint32]3000000000;ParentProcessId=200},
    [pscustomobject]@{ProcessId=400;ParentProcessId=[uint32]4000000000},
    [pscustomobject]@{ProcessId=$PID;ParentProcessId=0}
)
function Get-CimInstance {
    param([string]$ClassName,[string]$Filter)
    $script:calls++
    if($Filter){
        $parent=[int]($Filter -replace 'ParentProcessId=','')
        return $script:rows|Where-Object ParentProcessId -eq $parent
    }
    return $script:rows
}
`
        const output = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            setup + windowsProcessTreeCimCommand(100) + '\n"COUNT:$script:calls"'],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
        expect(output).toContain('OK:3000000000,300,200,100')
        expect(output).toContain('COUNT:1')
    })

    it('never emits a success sentinel when CIM enumeration fails', () => {
        const script = "function Get-CimInstance { throw 'fixture CIM failure' }\n" + windowsProcessTreeCimCommand(100)
        let failure: { status?: number; stdout?: string } | undefined
        try {
            execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
                { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: 'pipe' })
        } catch (error) { failure = error as typeof failure }
        expect(failure).toBeDefined()
        expect(failure?.status).not.toBe(0)
        expect(failure?.stdout ?? '').not.toContain('OK:')
    })

    it.each(['@()', '@([pscustomobject]@{ProcessId=100;ParentProcessId=0})'])(
        'rejects an empty or partial enumeration without success: %s', (rows) => {
            const script = `function Get-CimInstance { ${rows} }\n` + windowsProcessTreeCimCommand(100)
            let failure: { status?: number; stdout?: string } | undefined
            try {
                execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
                    { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: 'pipe' })
            } catch (error) { failure = error as typeof failure }
            expect(failure).toBeDefined()
            expect(failure?.status).not.toBe(0)
            expect(failure?.stdout ?? '').not.toContain('OK:')
        }
    )
})
