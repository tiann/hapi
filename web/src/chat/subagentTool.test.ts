import { describe, expect, it } from 'vitest'
import { isSubagentToolName } from '@/chat/subagentTool'

describe('isSubagentToolName', () => {
    it('recognizes canonical and lowercase agent aliases', () => {
        expect(isSubagentToolName('Task')).toBe(true)
        expect(isSubagentToolName('Agent')).toBe(true)
        expect(isSubagentToolName('task')).toBe(true)
        expect(isSubagentToolName('agent')).toBe(true)
        expect(isSubagentToolName('Task:Explore')).toBe(true)
        expect(isSubagentToolName('agent:review')).toBe(true)
    })

    it('does not match ordinary tool names containing task or agent', () => {
        expect(isSubagentToolName('task_status')).toBe(false)
        expect(isSubagentToolName('list_agents')).toBe(false)
        expect(isSubagentToolName('user-agent')).toBe(false)
    })
})
