/** Heartbeat timestamps belong to the Hub, not the phone's wall clock. */
export class HubClock {
    private sample: { epoch: number; received: number } | undefined
    observe(epoch: number): void {
        if (Number.isFinite(epoch) && (!this.sample || epoch >= this.sample.epoch)) {
            this.sample = { epoch, received: performance.now() }
        }
    }
    now(): number {
        return this.sample ? this.sample.epoch + performance.now() - this.sample.received : Date.now()
    }
}
