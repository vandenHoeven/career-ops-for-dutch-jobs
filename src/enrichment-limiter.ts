/** A separate limit keeps posting enrichment from occupying every discovery worker. */
export function createEnrichmentLimiter() {
  let active = 0;
  const hosts = new Set<string>();
  const waiters = new Set<() => void>();
  return async function run<T>(
    url: string,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<T> {
    const host = new URL(url).hostname;
    while (active >= 2 || hosts.has(host)) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const cleanup = () => {
          waiters.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    signal.throwIfAborted();
    active++;
    hosts.add(host);
    try {
      return await task();
    } finally {
      active--;
      hosts.delete(host);
      for (const wake of [...waiters]) wake();
    }
  };
}
