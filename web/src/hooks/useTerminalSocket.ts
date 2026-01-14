import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

type TerminalConnectionState =
    | { status: 'idle' }
    | { status: 'connecting' }
    | { status: 'connected' }
    | { status: 'error'; error: string }

type UseTerminalSocketOptions = {
    baseUrl: string
    token: string
    sessionId: string
    terminalId: string
}

type TerminalReadyPayload = {
    terminalId: string
}

type TerminalOutputPayload = {
    terminalId: string
    data: string
}

type TerminalExitPayload = {
    terminalId: string
    code: number | null
    signal: string | null
}

type TerminalErrorPayload = {
    terminalId: string
    message: string
}

export function useTerminalSocket(options: UseTerminalSocketOptions): {
    state: TerminalConnectionState
    connect: (cols: number, rows: number) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    disconnect: () => void
    onOutput: (handler: (data: string) => void) => void
    onExit: (handler: (code: number | null, signal: string | null) => void) => void
} {
    const [state, setState] = useState<TerminalConnectionState>({ status: 'idle' })
    const socketRef = useRef<Socket | null>(null)
    const outputHandlerRef = useRef<(data: string) => void>(() => {})
    const exitHandlerRef = useRef<(code: number | null, signal: string | null) => void>(() => {})
    const sessionIdRef = useRef(options.sessionId)
    const terminalIdRef = useRef(options.terminalId)
    const tokenRef = useRef(options.token)
    const baseUrlRef = useRef(options.baseUrl)
    const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)

    useEffect(() => {
        sessionIdRef.current = options.sessionId
        terminalIdRef.current = options.terminalId
        baseUrlRef.current = options.baseUrl
    }, [options.sessionId, options.terminalId, options.baseUrl])

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

    const isCurrentTerminal = useCallback((terminalId: string) => terminalId === terminalIdRef.current, [])

    const emitCreate = useCallback((socket: Socket, size: { cols: number; rows: number }) => {
        socket.emit('terminal:create', {
            sessionId: sessionIdRef.current,
            terminalId: terminalIdRef.current,
            cols: size.cols,
            rows: size.rows
        })
    }, [])

    const setErrorState = useCallback((message: string) => {
        setState({ status: 'error', error: message })
    }, [])

    const connect = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const token = tokenRef.current
        const sessionId = sessionIdRef.current
        const terminalId = terminalIdRef.current

        if (!token || !sessionId || !terminalId) {
            setErrorState('Missing terminal credentials.')
            return
        }

        if (socketRef.current) {
            const socket = socketRef.current
            socket.auth = { token }
            if (socket.connected) {
                emitCreate(socket, { cols, rows })
            } else {
                socket.connect()
            }
            setState({ status: 'connecting' })
            return
        }

        const socket = io(`${baseUrlRef.current}/terminal`, {
            auth: { token },
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['polling', 'websocket'],
            autoConnect: false
        })

        socketRef.current = socket
        setState({ status: 'connecting' })

        socket.on('connect', () => {
            const size = lastSizeRef.current ?? { cols, rows }
            setState({ status: 'connecting' })
            emitCreate(socket, size)
        })

        socket.on('terminal:ready', (payload: TerminalReadyPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            setState({ status: 'connected' })
        })

        socket.on('terminal:output', (payload: TerminalOutputPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            outputHandlerRef.current(payload.data)
        })

        socket.on('terminal:exit', (payload: TerminalExitPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            exitHandlerRef.current(payload.code, payload.signal)
            setErrorState('Terminal exited.')
        })

        socket.on('terminal:error', (payload: TerminalErrorPayload) => {
            if (!isCurrentTerminal(payload.terminalId)) {
                return
            }
            setErrorState(payload.message)
        })

        socket.on('connect_error', (error) => {
            const message = error instanceof Error ? error.message : 'Connection error'
            setErrorState(message)
        })

        socket.on('disconnect', (reason) => {
            if (reason === 'io client disconnect') {
                setState({ status: 'idle' })
                return
            }
            setErrorState(`Disconnected: ${reason}`)
        })

        socket.connect()
    }, [emitCreate, setErrorState, isCurrentTerminal])

    const write = useCallback((data: string) => {
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            return
        }
        socket.emit('terminal:write', { terminalId: terminalIdRef.current, data })
    }, [])

    const resize = useCallback((cols: number, rows: number) => {
        lastSizeRef.current = { cols, rows }
        const socket = socketRef.current
        if (!socket || !socket.connected) {
            return
        }
        socket.emit('terminal:resize', { terminalId: terminalIdRef.current, cols, rows })
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

    const onOutput = useCallback((handler: (data: string) => void) => {
        outputHandlerRef.current = handler
    }, [])

    const onExit = useCallback((handler: (code: number | null, signal: string | null) => void) => {
        exitHandlerRef.current = handler
    }, [])

    return {
        state,
        connect,
        write,
        resize,
        disconnect,
        onOutput,
        onExit
    }
}
