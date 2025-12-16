import { useEffect, useRef } from 'react'
import { io } from 'socket.io-client'
import type { SyncEvent } from '@/types/api'

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

type SocketSubscription = {
    all?: boolean
    sessionId?: string
    machineId?: string
}

export function useSocket(options: {
    enabled: boolean
    token: string
    subscription?: SocketSubscription
    onEvent: (event: SyncEvent) => void
    onConnect?: () => void
    onDisconnect?: (reason: string) => void
    onError?: (error: unknown) => void
}): void {
    const onEventRef = useRef(options.onEvent)
    const onConnectRef = useRef(options.onConnect)
    const onDisconnectRef = useRef(options.onDisconnect)
    const onErrorRef = useRef(options.onError)
    const subscriptionRef = useRef<SocketSubscription>(options.subscription ?? {})
    const socketRef = useRef<ReturnType<typeof io> | null>(null)

    useEffect(() => {
        onEventRef.current = options.onEvent
    }, [options.onEvent])

    useEffect(() => {
        onErrorRef.current = options.onError
    }, [options.onError])

    useEffect(() => {
        onConnectRef.current = options.onConnect
    }, [options.onConnect])

    useEffect(() => {
        onDisconnectRef.current = options.onDisconnect
    }, [options.onDisconnect])

    useEffect(() => {
        subscriptionRef.current = options.subscription ?? {}
    }, [options.subscription])

    useEffect(() => {
        if (!options.enabled) {
            socketRef.current?.disconnect()
            socketRef.current = null
            return
        }

        const socket = io('/webapp', {
            auth: { token: options.token },
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity
        })
        socketRef.current = socket

        const sendSubscribe = () => {
            socket.emit('subscribe', subscriptionRef.current)
        }
        const handleConnect = () => {
            sendSubscribe()
            onConnectRef.current?.()
        }
        const handleDisconnect = (reason: string) => {
            onDisconnectRef.current?.(reason)
        }

        socket.on('update', (event: unknown) => {
            if (!isObject(event)) return
            if (typeof event.type !== 'string') return
            onEventRef.current(event as SyncEvent)
        })

        socket.on('connect_error', (error) => {
            onErrorRef.current?.(error)
        })

        socket.on('error', (error) => {
            onErrorRef.current?.(error)
        })

        socket.on('connect', handleConnect)
        socket.on('disconnect', handleDisconnect)
        sendSubscribe()

        return () => {
            socket.off('connect', handleConnect)
            socket.off('disconnect', handleDisconnect)
            socket.disconnect()
            if (socketRef.current === socket) {
                socketRef.current = null
            }
        }
    }, [options.enabled, options.token])

    useEffect(() => {
        if (!options.enabled) {
            return
        }

        const socket = socketRef.current
        if (!socket) {
            return
        }

        socket.emit('subscribe', subscriptionRef.current)
    }, [options.enabled, options.subscription])
}
