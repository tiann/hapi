import { z } from 'zod'

export type TerminalSession = {
    terminalId: string
    cols: number
    rows: number
}

export const TerminalOpenPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

export type TerminalOpenPayload = z.infer<typeof TerminalOpenPayloadSchema>

export const TerminalWritePayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    data: z.string()
})

export type TerminalWritePayload = z.infer<typeof TerminalWritePayloadSchema>

export const TerminalResizePayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

export type TerminalResizePayload = z.infer<typeof TerminalResizePayloadSchema>

export const TerminalClosePayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1)
})

export type TerminalClosePayload = z.infer<typeof TerminalClosePayloadSchema>

export const TerminalReadyPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1)
})

export type TerminalReadyPayload = z.infer<typeof TerminalReadyPayloadSchema>

export const TerminalOutputPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    data: z.string()
})

export type TerminalOutputPayload = z.infer<typeof TerminalOutputPayloadSchema>

export const TerminalExitPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    code: z.number().int().nullable(),
    signal: z.string().nullable()
})

export type TerminalExitPayload = z.infer<typeof TerminalExitPayloadSchema>

export const TerminalErrorPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    message: z.string()
})

export type TerminalErrorPayload = z.infer<typeof TerminalErrorPayloadSchema>
