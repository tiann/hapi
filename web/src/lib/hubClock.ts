/** Heartbeat timestamps belong to the Hub, not the phone's wall clock. */
export class HubClock {
    private order = 0
    private sample: { epoch: number; received: number; order: number } | undefined
    beginSample(): number { return ++this.order }
    // REST reservations are ordered by request start. Each ordered SSE heartbeat
    // is a fresh observation, even if NTP moved the Hub wall clock backwards.
    observe(epoch: number, order = this.beginSample()): void {
        if (Number.isFinite(epoch) && (!this.sample || order >= this.sample.order)) {
            this.sample = { epoch, received: performance.now(), order }
        }
    }
    now(): number {
        return this.sample ? this.sample.epoch + performance.now() - this.sample.received : Date.now()
    }
}
