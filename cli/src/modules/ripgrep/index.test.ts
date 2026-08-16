/**
 * Tests for low-level ripgrep wrapper
 */

import { describe, it, expect } from 'vitest'
import { matchesFileSearchPath, run, runFileSearch, selectFileSearchPaths } from './index'

describe('ripgrep low-level wrapper', () => {
    it('should get version', async () => {
        const result = await run(['--version'])
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('ripgrep')
    })
    
    it('should search for pattern', async () => {
        const result = await run(['describe', 'src/modules/ripgrep/index.test.ts'])
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('describe')
    })
    
    it('should return exit code 1 for no matches', async () => {
        const result = await run(['ThisPatternShouldNeverMatch999', 'package.json'])
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
    })
    
    it('should handle JSON output', async () => {
        const result = await run(['--json', 'describe', 'src/modules/ripgrep/index.test.ts'])
        expect(result.exitCode).toBe(0)
        
        // Parse first line to check it's valid JSON
        const lines = result.stdout.trim().split('\n')
        const firstLine = JSON.parse(lines[0])
        expect(firstLine).toHaveProperty('type')
    })
    
    it('should respect custom working directory', async () => {
        const result = await run(['describe', 'index.test.ts'], { cwd: 'src/modules/ripgrep' })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('describe')
    })

    it('should apply shared wildcard semantics before enforcing the result limit', () => {
        expect(selectFileSearchPaths([
            'src/file.ts',
            'other.ts',
            'src/deep/file.ts'
        ], 'src*.ts', 2)).toEqual([
            'src/file.ts',
            'src/deep/file.ts'
        ])
    })

    it('should bound runner-side wildcard file-search output', async () => {
        const query = 'src/modules/ripgrep/*.ts'
        const result = await runFileSearch(['--files'], { query, limit: 1 })
        const paths = result.stdout.trim().split(/\r?\n/).filter(Boolean)

        expect(result.exitCode).toBe(0)
        expect(paths).toHaveLength(1)
        expect(matchesFileSearchPath(paths[0], query)).toBe(true)
    })
})
