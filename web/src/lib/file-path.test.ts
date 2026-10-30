import { describe, expect, it } from 'vitest'
import { resolveAbsoluteFilePath } from './file-path'

describe('resolveAbsoluteFilePath', () => {
    it('joins a relative path onto a POSIX workspace root', () => {
        expect(resolveAbsoluteFilePath('/home/me/project', 'src/foo.ts')).toBe('/home/me/project/src/foo.ts')
    })

    it('keeps a single leading separator when the root is "/"', () => {
        expect(resolveAbsoluteFilePath('/', 'etc/hosts')).toBe('/etc/hosts')
    })

    it('trims trailing separators from the root', () => {
        expect(resolveAbsoluteFilePath('/home/me/project/', 'src/foo.ts')).toBe('/home/me/project/src/foo.ts')
    })

    it('preserves literal backslashes in POSIX relative paths', () => {
        expect(resolveAbsoluteFilePath('/home/me/project', 'src/file\\name.ts')).toBe('/home/me/project/src/file\\name.ts')
    })

    it('treats a POSIX root containing a backslash as POSIX', () => {
        expect(resolveAbsoluteFilePath('/home/me\\project', 'src/foo.ts')).toBe('/home/me\\project/src/foo.ts')
    })

    it('joins a Windows-looking filename when the workspace is POSIX', () => {
        expect(resolveAbsoluteFilePath('/project', 'C:\\notes.txt')).toBe('/project/C:\\notes.txt')
        expect(resolveAbsoluteFilePath('/project', 'C:/notes.txt')).toBe('/project/C:/notes.txt')
    })

    it('uses backslashes for Windows roots and converts forward slashes', () => {
        expect(resolveAbsoluteFilePath('C:\\Users\\me\\project', 'src/foo.ts')).toBe('C:\\Users\\me\\project\\src\\foo.ts')
    })

    it('handles a bare drive root', () => {
        expect(resolveAbsoluteFilePath('C:', 'src/foo.ts')).toBe('C:\\src\\foo.ts')
    })

    it('returns the relative path when there is no workspace', () => {
        expect(resolveAbsoluteFilePath(undefined, 'src/foo.ts')).toBe('src/foo.ts')
        expect(resolveAbsoluteFilePath(null, 'src/foo.ts')).toBe('src/foo.ts')
        expect(resolveAbsoluteFilePath('', 'src/foo.ts')).toBe('src/foo.ts')
    })

    it('does not double-join an already absolute path', () => {
        expect(resolveAbsoluteFilePath('/root', '/etc/hosts')).toBe('/etc/hosts')
        expect(resolveAbsoluteFilePath('C:\\root', 'D:\\other\\file.ts')).toBe('D:\\other\\file.ts')
    })

    it('returns the workspace when the relative path is empty', () => {
        expect(resolveAbsoluteFilePath('/home/me/project', '')).toBe('/home/me/project')
    })
})
