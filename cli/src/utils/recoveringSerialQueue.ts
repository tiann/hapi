export class RecoveringSerialQueue {
    private tail: Promise<void> = Promise.resolve()

    constructor(private readonly onError: (error: unknown) => void) {}

    enqueue(task: () => Promise<void>): Promise<void> {
        const current = this.tail.then(task)
        this.tail = current.catch((error) => {
            try {
                this.onError(error)
            } catch {
                // Error reporting must not poison the serialization tail.
            }
        })
        return current
    }
}
