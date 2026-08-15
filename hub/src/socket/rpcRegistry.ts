import type { Socket } from 'socket.io'

type RpcRegistration = {
    socketId: string
    canUse: () => boolean
}

export class RpcRegistry {
    private readonly methodToRegistration: Map<string, RpcRegistration> = new Map()
    private readonly socketIdToMethods: Map<string, Set<string>> = new Map()

    register(socket: Socket, method: string, canUse: () => boolean = () => true): void {
        if (!method) {
            return
        }

        this.methodToRegistration.set(method, { socketId: socket.id, canUse })

        const existing = this.socketIdToMethods.get(socket.id)
        if (existing) {
            existing.add(method)
        } else {
            this.socketIdToMethods.set(socket.id, new Set([method]))
        }
    }

    unregister(socket: Socket, method: string): void {
        const registration = this.methodToRegistration.get(method)
        if (registration?.socketId === socket.id) {
            this.methodToRegistration.delete(method)
        }

        const methods = this.socketIdToMethods.get(socket.id)
        if (methods) {
            methods.delete(method)
            if (methods.size === 0) {
                this.socketIdToMethods.delete(socket.id)
            }
        }
    }

    unregisterAll(socket: Socket): void {
        const methods = this.socketIdToMethods.get(socket.id)
        if (!methods) {
            return
        }
        for (const method of methods) {
            const registration = this.methodToRegistration.get(method)
            if (registration?.socketId === socket.id) {
                this.methodToRegistration.delete(method)
            }
        }
        this.socketIdToMethods.delete(socket.id)
    }

    getSocketIdForMethod(method: string): string | null {
        const registration = this.methodToRegistration.get(method)
        if (!registration) return null
        let usable = false
        try {
            usable = registration.canUse()
        } catch {
            usable = false
        }
        if (!usable) {
            this.methodToRegistration.delete(method)
            const methods = this.socketIdToMethods.get(registration.socketId)
            methods?.delete(method)
            if (methods?.size === 0) {
                this.socketIdToMethods.delete(registration.socketId)
            }
            return null
        }
        return registration.socketId
    }
}
