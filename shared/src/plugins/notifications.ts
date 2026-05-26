import { z } from 'zod'
import { SessionEndReasonSchema } from '../schemas'

export const PluginNotificationEventTypeSchema = z.enum([
    'ready',
    'permission-request',
    'task-notification',
    'session-completion',
    'test'
])

export const PluginNotificationSessionSchema = z.object({
    id: z.string().min(1),
    namespace: z.string().min(1),
    name: z.string().optional(),
    path: z.string().optional(),
    agent: z.string().optional(),
    active: z.boolean(),
    url: z.string().optional()
}).strict()

export const PluginNotificationEventSchema = z.object({
    type: PluginNotificationEventTypeSchema,
    session: PluginNotificationSessionSchema,
    task: z.object({
        summary: z.string(),
        status: z.string().optional()
    }).strict().optional(),
    reason: SessionEndReasonSchema.optional()
}).strict()

export type PluginNotificationEventType = z.infer<typeof PluginNotificationEventTypeSchema>
export type PluginNotificationSession = z.infer<typeof PluginNotificationSessionSchema>
export type PluginNotificationEvent = z.infer<typeof PluginNotificationEventSchema>
