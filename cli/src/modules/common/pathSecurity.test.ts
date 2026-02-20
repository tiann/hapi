import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { validatePath, validateRealPath } from './pathSecurity'

describe('validatePath', () => {
    const workingDir = '/home/user/project'

    it('should allow paths within working directory', () => {
        expect(validatePath('/home/user/project/file.txt', workingDir).valid).toBe(true)
        expect(validatePath('file.txt', workingDir).valid).toBe(true)
        expect(validatePath('./src/file.txt', workingDir).valid).toBe(true)
    })

    it('should reject paths outside working directory', () => {
        const result = validatePath('/etc/passwd', workingDir)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside the working directory')
    })

    it('should prevent path traversal attacks', () => {
        const result = validatePath('../../.ssh/id_rsa', workingDir)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside the working directory')
    })

    it('should correctly handle working directory at filesystem root', () => {
        const rootDir = '/'
        expect(validatePath('/etc/passwd', rootDir).valid).toBe(true)
        expect(validatePath('etc/passwd', rootDir).valid).toBe(true)
    })

    it('should not treat sibling directories as inside working directory', () => {
        const result = validatePath('/home/user/project2/file.txt', workingDir)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('outside the working directory')
    })

    it('should allow the working directory itself', () => {
        expect(validatePath('.', workingDir).valid).toBe(true)
        expect(validatePath(workingDir, workingDir).valid).toBe(true)
    })
})

describe('validateRealPath', () => {
    let workingDir: string
    let outsideDir: string

    beforeEach(async () => {
        workingDir = await mkdtemp(join(tmpdir(), 'hapi-path-security-working-'))
        outsideDir = await mkdtemp(join(tmpdir(), 'hapi-path-security-outside-'))
    })

    afterEach(async () => {
        await rm(workingDir, { recursive: true, force: true })
        await rm(outsideDir, { recursive: true, force: true })
    })

    it('rejects symlinks that point outside the working directory', async () => {
        const outsideFile = join(outsideDir, 'outside.txt')
        const linkPath = join(workingDir, 'escape-link.txt')
        await writeFile(outsideFile, 'outside')

        try {
            await symlink(outsideFile, linkPath)
        } catch {
            // Symlink creation may be unavailable (Windows, container policy)
            return
        }

        const result = await validateRealPath(linkPath, workingDir)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Access denied: symlink traversal outside working directory')
    })

    it('allows regular files within the working directory', async () => {
        const insideFile = join(workingDir, 'inside.txt')
        await writeFile(insideFile, 'inside')

        const result = await validateRealPath(insideFile, workingDir)
        expect(result.valid).toBe(true)
    })

    it('allows non-existent paths for create operations', async () => {
        const newFile = join(workingDir, 'new-file.txt')
        const result = await validateRealPath(newFile, workingDir)
        expect(result.valid).toBe(true)
    })

    it('allows symlinks that point within the working directory', async () => {
        const targetFile = join(workingDir, 'target.txt')
        const linkPath = join(workingDir, 'inside-link.txt')
        await writeFile(targetFile, 'target')

        try {
            await symlink(targetFile, linkPath)
        } catch {
            return
        }

        const result = await validateRealPath(linkPath, workingDir)
        expect(result.valid).toBe(true)
    })

    it('falls back to resolve() when workingDirectory realpath fails', async () => {
        const outsideFile = join(outsideDir, 'outside.txt')
        await writeFile(outsideFile, 'outside')

        const missingWorkingDir = join(workingDir, 'missing-root')
        const result = await validateRealPath(outsideFile, missingWorkingDir)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Access denied: symlink traversal outside working directory')
    })
})
