export async function waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
    intervalMs = 25
): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
        if (await condition()) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (await condition()) {
        return;
    }

    throw new Error(`Timeout waiting for condition after ${timeoutMs}ms`);
}
