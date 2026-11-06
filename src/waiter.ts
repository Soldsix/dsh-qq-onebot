/** Cancellation for one waiter without cancelling an underlying shared request. */

/** A completed request and a cancelled wait are separate outcomes. */
export type WaitResult<T> = { readonly kind: 'value'; readonly value: T } | { readonly kind: 'cancelled' }

/**
 * Wait for a shared operation while retaining its lifetime for other consumers.
 * @param task - operation owned independently of this wait.
 * @param signal - this waiter's cancellation signal.
 * @returns the value, cancellation, or the original operation rejection.
 */
export function waitFor<T>(task: Promise<T>, signal: AbortSignal): Promise<WaitResult<T>> {
  if (signal.aborted) return Promise.resolve({ kind: 'cancelled' })
  return new Promise((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); resolve({ kind: 'cancelled' }) }
    signal.addEventListener('abort', abort, { once: true })
    void task.then(value => { signal.removeEventListener('abort', abort); resolve({ kind: 'value', value }) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
