import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLocksFake } from './locks-fake';
import { Spoke, type RecoveryEvent } from '../src/hub';

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

let spokes: Spoke[] = [];

beforeEach(() => {
  installLocksFake();
  FakeWorker.instances = [];
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

function makeSpoke(name: string): Spoke {
  // No hub ever acquires the leadership lock in these tests, so every service
  // call queues and rejects at callTimeout — simulating a wedged hub whose
  // calls never return (heartbeats are irrelevant to the stall detector).
  const spoke = new Spoke({ workerUrl: 'fake-hub.js', name, callTimeout: 150 });
  spokes.push(spoke);
  return spoke;
}

function setLeader(spoke: Spoke, isLeader: boolean) {
  const worker = (spoke as any).worker as FakeWorker;
  worker.dispatchEvent(new MessageEvent('message', { data: { type: 'tab-election:leadership', isLeader } }));
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

  it('a successful call resets the stall counter', async () => {
    const spoke = makeSpoke('stall-reset');
    setLeader(spoke, true);
    const svc = spoke.getService<any>('svc');

    await expect(svc.doWork()).rejects.toThrow('Call timed out');
    // A hub comes alive and answers one call — the earlier timeout must not count anymore.
    (spoke as any)._consecutiveCallTimeouts = (spoke as any)._consecutiveCallTimeouts; // (no-op, readability)
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
});
