import { useCallback, useEffect, useRef, useState } from 'react'
import { Manager, type Socket } from 'socket.io-client'

type AgentTerminalConnectionState =
    | { status: 'idle' }
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; error: string }

type UseAgentTerminalSocketOptions = {
    baseUrl: string
    token: string
    sessionId: string
}

type TerminalOutputPayload = {
    terminalId: string
    data: string
}

export function useAgentTerminalSocket(options: UseAgentTerminalSocketOptions): {
    state: AgentTerminalConnectionState
    connect: () => void
    disconnect: () => void
    resubscribe: () => void
    unsubscribe: () => void
    onOutput: (handler: (data: string) => void) => void
    resize: (cols: number, rows: number) => void
    sendInput: (data: string) => void
} {
    const [state, setState] = useState<AgentTerminalConnectionState>({ status: 'idle' })
    const socketRef = useRef<Socket | null>(null)
    const outputHandlerRef = useRef<(data: string) => void>(() => {})
    const sessionIdRef = useRef(options.sessionId)
    const tokenRef = useRef(options.token)
    const baseUrlRef = useRef(options.baseUrl)
    // Whether the viewer currently wants the PTY streamed. Connecting alone must
    // NOT subscribe — SessionChat mounts this hidden for every PTY session, and
    // an unconditional subscribe-on-connect would stream the high-frequency raw
    // TUI even when the terminal is never opened. Subscribe is gated on this so
    // (re)connects only re-subscribe when the terminal is actually visible.
    const subscribedRef = useRef(false)

    useEffect(() => {
        sessionIdRef.current = options.sessionId
        baseUrlRef.current = options.baseUrl
    }, [options.sessionId, options.baseUrl])

    useEffect(() => {
        tokenRef.current = options.token
        const socket = socketRef.current
        if (!socket) {
            return
        }
        if (!options.token) {
            if (socket.connected) {
                socket.disconnect()
            }
            return
        }
        socket.auth = { token: options.token }
        if (socket.connected) {
            socket.disconnect()
            socket.connect()
        }
    }, [options.token])

    const connect = useCallback(() => {
        const token = tokenRef.current
        const sessionId = sessionIdRef.current

        if (!token || !sessionId) {
            setState({ status: 'error', error: 'Missing terminal credentials.' })
            return
        }

        if (socketRef.current) {
            const socket = socketRef.current
            socket.auth = { token }
            if (socket.connected) {
                setState({ status: 'connected' })
            } else {
                socket.connect()
            }
            return
        }

        const manager = new Manager(baseUrlRef.current, {
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['polling', 'websocket'],
            autoConnect: false
        })
        const socket = manager.socket('/terminal', {
            auth: { token }
        })

        socketRef.current = socket
        setState({ status: 'connecting' })

        socket.on('connect', () => {
            // Re-subscribe across reconnects only if the viewer still wants it.
            if (subscribedRef.current) {
                socket.emit('agent-terminal:subscribe', { sessionId })
            }
            setState({ status: 'connected' })
        })

        socket.on('agent-terminal:output', (payload: TerminalOutputPayload) => {
            if (payload.terminalId !== 'agent') {
                return
            }
            outputHandlerRef.current(payload.data)
        })

        socket.on('connect_error', (error) => {
            const message = error instanceof Error ? error.message : 'Connection error'
            setState({ status: 'error', error: message })
        })

        socket.on('disconnect', (reason) => {
            if (reason === 'io client disconnect') {
                setState({ status: 'idle' })
                return
            }
            setState({ status: 'error', error: `Disconnected: ${reason}` })
        })

        socket.connect()
    }, [])

    const disconnect = useCallback(() => {
        const socket = socketRef.current
        if (!socket) {
            return
        }
        socket.removeAllListeners()
        socket.disconnect()
        socketRef.current = null
        setState({ status: 'idle' })
    }, [])

    const resubscribe = useCallback(() => {
        subscribedRef.current = true
        const socket = socketRef.current
        const sessionId = sessionIdRef.current
        if (socket?.connected && sessionId) {
            socket.emit('agent-terminal:subscribe', { sessionId })
        }
    }, [])

    // Tell the hub we're no longer viewing, so the CLI can stop streaming the PTY
    // when no viewers remain. (Safe to miss — the runner keeps streaming until it
    // hears this, never the other way around, so a missed unsubscribe never
    // causes a black screen.)
    const unsubscribe = useCallback(() => {
        subscribedRef.current = false
        const socket = socketRef.current
        const sessionId = sessionIdRef.current
        if (socket?.connected && sessionId) {
            socket.emit('agent-terminal:unsubscribe', { sessionId })
        }
    }, [])

    const resize = useCallback((cols: number, rows: number) => {
        const socket = socketRef.current
        const sessionId = sessionIdRef.current
        if (!socket?.connected || !sessionId || cols < 1 || rows < 1) {
            return
        }
        socket.emit('agent-terminal:resize', { sessionId, cols, rows })
    }, [])

    const onOutput = useCallback((handler: (data: string) => void) => {
        outputHandlerRef.current = handler
    }, [])

    const sendInput = useCallback((data: string) => {
        const socket = socketRef.current
        const sessionId = sessionIdRef.current
        if (!socket?.connected || !sessionId || !data) {
            return
        }
        socket.emit('agent-terminal:input', { sessionId, data })
    }, [])

    return {
        state,
        connect,
        disconnect,
        resubscribe,
        unsubscribe,
        onOutput,
        resize,
        sendInput
    }
}
