import { z } from 'zod'

export const PluginStatusSchema = z.enum([
    'discovered',
    'validated',
    'enabled',
    'active',
    'degraded',
    'failed',
    'reload-failed',
    'disabled',
    'incompatible',
    'blocked',
    'invalid'
])

export type PluginStatus = z.infer<typeof PluginStatusSchema>

export const PluginDiagnosticSeveritySchema = z.enum(['info', 'warning', 'error'])
export type PluginDiagnosticSeverity = z.infer<typeof PluginDiagnosticSeveritySchema>

export const PluginDiagnosticSchema = z.object({
    severity: PluginDiagnosticSeveritySchema,
    code: z.string().min(1),
    message: z.string().min(1),
    path: z.string().optional()
}).strict()

export type PluginDiagnostic = z.infer<typeof PluginDiagnosticSchema>
