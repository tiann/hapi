import { describe, expect, it } from 'vitest'
import { ThreadGoalSchema } from './schemas'

describe('ThreadGoalSchema upstream status compatibility', () => {
    it.each(['blocked', 'usageLimited'] as const)('accepts %s goal updates', (status) => {
        const result = ThreadGoalSchema.safeParse({
            threadId: 'thread-1',
            objective: 'Finish the long-running task',
            status
        })

        expect(result.success).toBe(true)
        expect(result.data?.status).toBe(status)
    })
})
