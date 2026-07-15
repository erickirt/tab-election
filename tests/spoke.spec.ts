import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLocksFake } from './locks-fake';
import { Spoke, type RecoveryEvent, type RecoveryFailedEvent, type SpokeOptions } from '../src/hub';
import { Tab } from '../src/tab';

/**
 * Pins the SPOKE-2 fix: a hub that keeps heartbeating (its heartbeat interval
 * is independent of service-call drain) but never returns service calls must
 * be recovered after consecutive call timeouts — heartbeat-gap recovery alone
 * never fires for this failure mode.
 */

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  terminated = false;
  constructor(
    public url: string,
    public options?: { type?: string; name?: string },
  ) {
    super();
    FakeWorker.instances.push(this);
  }
  terminate() {
    this.terminated = true;
  }
  postMessage() {}
}

class FakeSharedWorkerPort {
  closed = false;
  close() {
    this.closed = true;
  }
  start() {}
  postMessage() {}
}

class FakeSharedWorker extends EventTarget {
  static instances: FakeSharedWorker[] = [];
  port = new FakeSharedWorkerPort();
  constructor(
    public url: string,
    public options?: { type?: string; name?: string },
  ) {
    super();
    FakeSharedWorker.instances.push(this);
  }
}

let spokes: Spoke[] = [];

beforeEach(() => {
  installLocksFake();
  FakeWorker.instances = [];
  FakeSharedWorker.instances = [];
  (globalThis as any).Worker = FakeWorker;
  delete (globalThis as any).SharedWorker;
});

afterEach(() => {
  for (const spoke of spokes) {
    spoke.close();
    (spoke as any).tab.close();
  }
  spokes = [];
});

function makeSpoke(name: string, options?: Partial<SpokeOptions>): Spoke {
  // No hub ever acquires the leadership lock in these tests, so every service
  // call queues and rejects at callTimeout — simulating a wedged hub whose
  // calls never return (heartbeats are irrelevant to the stall detector).
  const spoke = new Spoke({ workerUrl: 'fake-hub.js', name, callTimeout: 150, ...options });
  spokes.push(spoke);
  return spoke;
}

function setLeader(spoke: Spoke, isLeader: boolean) {
  const worker = (spoke as any).worker as FakeWorker;
  worker.dispatchEvent(new MessageEvent('message', { data: { type: 'tab-election:leadership', isLeader } }));
}

function currentWorker(spoke: Spoke): FakeWorker {
  return (spoke as any).worker as FakeWorker;
}

// Node has no ErrorEvent global; the spoke only reads `.message` off the event.
class FakeErrorEvent extends Event {
  constructor(public message: string) {
    super('error');
  }
}

/** Deliver a hub heartbeat over the shared tab channel, as a live leader would. */
async function sendHeartbeat(name: string) {
  const hubTab = new Tab(`hub/${name}/0.0.0`);
  hubTab.send({ type: 'tab-election:heartbeat' });
  await wait(20); // broadcast delivery
  hubTab.close();
}

describe('Spoke call-stall recovery', () => {
  it('recovers its own worker after two consecutive call timeouts when it owns the leader', async () => {
    const spoke = makeSpoke('stall-owner');
    setLeader(spoke, true);
    const recoveries: RecoveryEvent[] = [];
    spoke.onRecovery(e => recoveries.push(e));
    const svc = spoke.getService<any>('svc');

    const first = FakeWorker.instances[0];
    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    expect(first.terminated).toBe(false); // one timeout may just be a slow call
    await expect(svc.doWork()).rejects.toThrow('Call timed out');

    expect(first.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(recoveries).toEqual([{ reason: 'call-stall', attempt: 1 }]);
  });

  it('broadcasts recovery when it does not own the leader, and the owner acts on it', async () => {
    const owner = makeSpoke('stall-remote');
    setLeader(owner, true);
    const observer = makeSpoke('stall-remote');
    setLeader(observer, false);
    // A heartbeat proves a live leader exists somewhere: without one the
    // observer would treat its own never-alive worker as the problem and
    // recover it directly instead of deferring to the owner.
    await sendHeartbeat('stall-remote');
    const ownerRecoveries: RecoveryEvent[] = [];
    owner.onRecovery(e => ownerRecoveries.push(e));

    const ownerWorker = (owner as any).worker as FakeWorker;
    const observerWorker = (observer as any).worker as FakeWorker;
    const svc = observer.getService<any>('svc');
    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    await wait(30); // broadcast delivery

    expect(observerWorker.terminated).toBe(false); // the non-owner never recovers its own worker
    expect(ownerWorker.terminated).toBe(true);
    expect(ownerRecoveries).toEqual([{ reason: 'call-stall', attempt: 1 }]);
  });

  it('a successful call resets the stall counter for that method', async () => {
    const spoke = makeSpoke('stall-reset');
    setLeader(spoke, true);
    const svc = spoke.getService<any>('svc');

    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    // A hub comes alive and answers one call — the earlier timeout must not count anymore.
    const { Tab } = await import('../src/tab');
    const hubTab = new Tab('hub/stall-reset/0.0.0');
    hubTab.waitForLeadership(() => ({ svc: { doWork: async () => 'ok' } }));
    await wait(20);
    await expect(svc.doWork()).resolves.toBe('ok');
    hubTab.relinquishLeadership();
    hubTab.close();
    await wait(20);

    const first = FakeWorker.instances[0];
    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    expect(first.terminated).toBe(false); // counter was reset — this is timeout #1, not #2
  });

  /**
   * The write-path-only wedge (DAB-684, 2026-07-15): a hub whose write loop has
   * starved while its RPC dispatcher still answers cheap reads. A user sat
   * wedged for 86 minutes with ZERO recoveries because the spoke-wide counter
   * was zeroed by unrelated healthy traffic — presence leases every 20s, tab
   * pings every 30s, liveness probes every 15s — between write timeouts ~2min
   * apart. The starved path must reach the threshold on its own evidence.
   */
  it('a successful call to a DIFFERENT method does not reset the stall counter', async () => {
    const spoke = makeSpoke('stall-per-method');
    setLeader(spoke, true);
    const recoveries: RecoveryEvent[] = [];
    spoke.onRecovery(e => recoveries.push(e));
    const svc = spoke.getService<any>('svc');

    // A hub that answers `ping` but never drains `doWork` — the wedge shape.
    // `doWork` must EXIST and hang: an absent method rejects as "Invalid API
    // method", which comes back through the hub and counts as liveness.
    const { Tab } = await import('../src/tab');
    const hubTab = new Tab('hub/stall-per-method/0.0.0');
    hubTab.waitForLeadership(() => ({
      svc: { ping: async () => 'pong', doWork: () => new Promise<never>(() => {}) },
    }));
    await wait(20);

    const first = FakeWorker.instances[0];
    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    await expect(svc.ping()).resolves.toBe('pong'); // healthy traffic must not erase the evidence
    await expect(svc.doWork()).rejects.toThrow('Call timed out');

    expect(first.terminated).toBe(true);
    expect(recoveries).toEqual([{ reason: 'call-stall', attempt: 1 }]);

    hubTab.relinquishLeadership();
    hubTab.close();
  });

  it('counts timeouts on different methods separately', async () => {
    const spoke = makeSpoke('stall-independent');
    setLeader(spoke, true);
    const svc = spoke.getService<any>('svc');

    const first = FakeWorker.instances[0];
    // One timeout each on two methods is not two consecutive timeouts on either.
    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    await expect(svc.otherWork()).rejects.toThrow('Call timed out');

    expect(first.terminated).toBe(false);
  });
});

/**
 * Pins the respawn-thrash fix (2026-07-14): a worker whose script can never
 * load again (a deploy purged the old hashed asset, so the URL serves the SPA
 * fallback) used to be terminated and re-fetched on every heartbeat gap —
 * an infinite ~6/min loop that left sync dead for hours. Boot failures now
 * recover immediately but back off exponentially while fruitless, and a
 * terminal `onRecoveryFailed` tells the app to escalate.
 */
describe('Spoke boot-failure recovery and backoff', () => {
  it('recovers its own worker on an error before any heartbeat, even when not leader', async () => {
    const spoke = makeSpoke('boot-fail');
    const recoveries: RecoveryEvent[] = [];
    spoke.onRecovery(e => recoveries.push(e));

    const first = currentWorker(spoke);
    first.dispatchEvent(new FakeErrorEvent('Failed to fetch worker script'));

    expect(first.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(recoveries).toEqual([{ reason: 'boot-failure', attempt: 1 }]);
  });

  it('recovers a never-booted SharedWorker too: port closed, replacement carries the recovery suffix', () => {
    (globalThis as any).SharedWorker = FakeSharedWorker;
    const spoke = makeSpoke('boot-fail-shared', { useSharedWorker: true });
    const recoveries: RecoveryEvent[] = [];
    spoke.onRecovery(e => recoveries.push(e));

    const first = FakeSharedWorker.instances[0];
    first.dispatchEvent(new FakeErrorEvent('Failed to fetch worker script'));

    expect(first.port.closed).toBe(true);
    expect(FakeSharedWorker.instances).toHaveLength(2);
    // The recovery suffix makes the browser mint a fresh SharedWorker process;
    // the Hub parses it and takes the leadership lock with steal:true.
    expect(FakeSharedWorker.instances[1].options?.name).toBe('boot-fail-shared:0.0.0:recover-1');
    expect(recoveries).toEqual([{ reason: 'boot-failure', attempt: 1 }]);
  });

  it('ignores worker errors once a heartbeat has proven the hub alive', async () => {
    const spoke = makeSpoke('boot-runtime-error');
    await sendHeartbeat('boot-runtime-error');

    currentWorker(spoke).dispatchEvent(new FakeErrorEvent('some runtime error'));

    expect(FakeWorker.instances).toHaveLength(1);
    expect(currentWorker(spoke).terminated).toBe(false);
  });

  it('backs off between fruitless recoveries instead of thrashing', async () => {
    const spoke = makeSpoke('boot-backoff', { recoveryBackoffMinMs: 80, recoveryBackoffMaxMs: 1000 });

    currentWorker(spoke).dispatchEvent(new FakeErrorEvent('gone')); // recovery 1: immediate
    expect(FakeWorker.instances).toHaveLength(2);

    // Still inside the 80ms window — the replacement's failure must NOT respawn yet.
    currentWorker(spoke).dispatchEvent(new FakeErrorEvent('gone'));
    expect(FakeWorker.instances).toHaveLength(2);

    await wait(100);
    currentWorker(spoke).dispatchEvent(new FakeErrorEvent('gone')); // window passed
    expect(FakeWorker.instances).toHaveLength(3);
  });

  it('fires onRecoveryFailed once after repeated fruitless recoveries, with the last error', async () => {
    const spoke = makeSpoke('boot-terminal', { recoveryBackoffMinMs: 1, recoveryBackoffMaxMs: 4, maxFruitlessRecoveries: 2 });
    const failures: RecoveryFailedEvent[] = [];
    spoke.onRecoveryFailed(e => failures.push(e));

    for (let i = 0; i < 4; i++) {
      currentWorker(spoke).dispatchEvent(new FakeErrorEvent(`load failed #${i + 1}`));
      await wait(10);
    }

    expect(failures).toHaveLength(1);
    expect(failures[0].attempts).toBe(3); // fired on the first recovery past the max
    expect(failures[0].lastError).toBe('load failed #3');
  });

  it('a heartbeat closes the episode: backoff resets and onRecoveryFailed re-arms', async () => {
    const spoke = makeSpoke('boot-reset', { recoveryBackoffMinMs: 60_000, maxFruitlessRecoveries: 2 });
    setLeader(spoke, true);
    const failures: RecoveryFailedEvent[] = [];
    spoke.onRecoveryFailed(e => failures.push(e));

    currentWorker(spoke).dispatchEvent(new FakeErrorEvent('gone'));
    expect(FakeWorker.instances).toHaveLength(2);
    // Fruitless once — the next failure sits behind a 60s backoff…
    currentWorker(spoke).dispatchEvent(new FakeErrorEvent('gone'));
    expect(FakeWorker.instances).toHaveLength(2);

    // …until a heartbeat proves a hub came alive, closing the episode. (A
    // worker error after a heartbeat is a runtime error, not a boot failure,
    // so the next episode is driven through call-stall detection instead.)
    await sendHeartbeat('boot-reset');
    expect((spoke as any)._recoveriesSinceHeartbeat).toBe(0);

    const svc = spoke.getService<any>('svc');
    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    // Recovery ran immediately again — new episode, no backoff, no terminal.
    expect(FakeWorker.instances).toHaveLength(3);
    expect(failures).toHaveLength(0);
  });
});
