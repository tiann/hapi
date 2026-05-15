import { describe, expect, it } from 'vitest'
import {
    formatDiffError,
    formatDirectoryError,
    formatFileSearchError,
    formatGitStatusError,
    formatReadFileError,
    getDetachedBranchLabel,
    getProjectRootLabel,
} from './files-i18n'

const translations: Record<string, string> = {
    'files.projectRoot': '项目根目录',
    'files.branch.detached': '游离 HEAD',
    'files.search.error.failed': '搜索文件失败',
    'files.search.error.failedWithDetail': '搜索文件失败：{error}',
    'files.directories.error.listFailed': '加载目录失败',
    'files.directories.error.listFailedWithDetail': '加载目录失败：{error}',
    'files.changes.error.gitStatusUnavailable': 'Git 状态不可用',
    'files.changes.error.gitStatusUnavailableWithDetail': 'Git 状态不可用：{error}',
    'files.changes.error.unstagedDiffUnavailableWithDetail': '未暂存 Diff 不可用：{error}',
    'files.changes.error.stagedDiffUnavailableWithDetail': '已暂存 Diff 不可用：{error}',
    'file.error.readFailed': '读取文件失败',
    'file.error.readFailedWithDetail': '读取文件失败：{error}',
    'file.error.diffUnavailable': 'Diff 不可用',
    'file.error.diffUnavailableWithDetail': 'Diff 不可用：{error}',
}

function t(key: string, params?: Record<string, string | number>): string {
    const template = translations[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

describe('files i18n helpers', () => {
    it('localizes common file tree labels', () => {
        expect(getProjectRootLabel('', t)).toBe('项目根目录')
        expect(getProjectRootLabel('src/routes', t)).toBe('src/routes')
        expect(getDetachedBranchLabel('detached', t)).toBe('游离 HEAD')
        expect(getDetachedBranchLabel('main', t)).toBe('main')
    })

    it('formats git status errors with translated summaries', () => {
        expect(formatGitStatusError('Git status unavailable', t)).toBe('Git 状态不可用')
        expect(formatGitStatusError('Unstaged diff unavailable: fatal', t)).toBe('未暂存 Diff 不可用：fatal')
        expect(formatGitStatusError('Staged diff unavailable: timeout', t)).toBe('已暂存 Diff 不可用：timeout')
        expect(
            formatGitStatusError(
                'Unstaged diff unavailable: fatal Staged diff unavailable: timeout',
                t
            )
        ).toBe('未暂存 Diff 不可用：fatal 已暂存 Diff 不可用：timeout')
        expect(formatGitStatusError('fatal: not a git repository', t)).toBe('Git 状态不可用：fatal: not a git repository')
    })

    it('formats search and directory errors', () => {
        expect(formatFileSearchError('Failed to search files', t)).toBe('搜索文件失败')
        expect(formatFileSearchError('ripgrep exited 2', t)).toBe('搜索文件失败：ripgrep exited 2')
        expect(formatDirectoryError('Failed to list directory', t)).toBe('加载目录失败')
        expect(formatDirectoryError('permission denied', t)).toBe('加载目录失败：permission denied')
    })

    it('formats file read and diff errors', () => {
        expect(formatReadFileError('Failed to read file', t)).toBe('读取文件失败')
        expect(formatReadFileError('EACCES', t)).toBe('读取文件失败：EACCES')
        expect(formatDiffError('Failed to load diff', t)).toBe('Diff 不可用')
        expect(formatDiffError('fatal: bad revision', t)).toBe('Diff 不可用：fatal: bad revision')
    })
})
