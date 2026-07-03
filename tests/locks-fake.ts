/**
 * Minimal in-process fake of navigator.locks (Web Locks API) covering what
 * Tab uses: exclusive queued requests, `ifAvailable`, `steal`, and `signal`
 * (rejecting with the abort reason, matching the platform behavior Tab's
 * `relinquishLeadership` relies on).
 */
type Callback = (lock: { name: string } | null) => unknown;

interface Waiter {
  cb: Callback;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  steal?: boolean;
}

export class LocksFake {
  private held = new Map<string, { finished: Promise<unknown>; abort: (reason: unknown) => void }>();
  private queues = new Map<string, Waiter[]>();

  request(name: string, cbOrOptions: Callback | LockOptions, maybeCb?: Callback): Promise<unknown> {
    const options = (typeof cbOrOptions === 'function' ? {} : cbOrOptions) as LockOptions;
    const cb = (typeof cbOrOptions === 'function' ? cbOrOptions : maybeCb)!;

    return new Promise((resolve, reject) => {
      if (options.ifAvailable) {
        if (this.held.has(name)) {
          Promise.resolve(cb(null)).then(resolve, reject);
        } else {
          this.grant(name, { cb, resolve, reject });
        }
        return;
      }

      if (options.steal) {
        const current = this.held.get(name);
        if (current) {
          this.held.delete(name);
          current.abort(new DOMException('The lock was stolen.', 'AbortError'));
        }
        this.grant(name, { cb, resolve, reject });
        return;
      }

      const waiter: Waiter = { cb, resolve, reject, signal: options.signal ?? undefined };
      if (waiter.signal?.aborted) {
        reject((waiter.signal as any).reason);
        return;
      }
      waiter.signal?.addEventListener('abort', () => {
        const queue = this.queues.get(name);
        const i = queue?.indexOf(waiter) ?? -1;
        if (i >= 0) {
          queue!.splice(i, 1);
          reject((waiter.signal as any).reason);
        }
      });

      if (!this.held.has(name)) {
        this.grant(name, waiter);
      } else {
        const queue = this.queues.get(name) ?? [];
        queue.push(waiter);
        this.queues.set(name, queue);
      }
    });
  }

  private grant(name: string, waiter: Pick<Waiter, 'cb' | 'resolve' | 'reject'>): void {
    let abort!: (reason: unknown) => void;
    const aborted = new Promise((_, rej) => (abort = rej));
    const finished = Promise.race([Promise.resolve().then(() => waiter.cb({ name })), aborted]);
    this.held.set(name, { finished, abort });
    finished
      .then(waiter.resolve, waiter.reject)
      .finally(() => {
        if (this.held.get(name)?.finished === finished) this.held.delete(name);
        const next = this.queues.get(name)?.shift();
        if (next) this.grant(name, next);
      });
  }
}

interface LockOptions {
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal | null;
}

/** Install the fake on globalThis.navigator (Node's navigator is read-only, so replace it). */
export function installLocksFake(): LocksFake {
  const locks = new LocksFake();
  Object.defineProperty(globalThis, 'navigator', {
    value: { locks },
    configurable: true,
    writable: true,
  });
  return locks;
}
