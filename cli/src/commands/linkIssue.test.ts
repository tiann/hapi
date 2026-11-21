import { describe, expect, it } from 'vitest'
import { LinkIssueError } from '@/modules/linkIssue/linkIssue'
import { handleLinkIssueCommand } from './linkIssue'

describe('handleLinkIssueCommand', () => {
    it('rejects a missing url without attempting a network call', async () => {
        await expect(handleLinkIssueCommand([])).rejects.toThrow(LinkIssueError)
        await expect(handleLinkIssueCommand([])).rejects.toMatchObject({ code: 'bad_args' })
    })

    it('shows help and returns without throwing for --help / -h', async () => {
        await expect(handleLinkIssueCommand(['--help'])).resolves.toBeUndefined()
        await expect(handleLinkIssueCommand(['-h'])).resolves.toBeUndefined()
    })
})
