import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLocksFake, type LocksFake } from './locks-fake';
import { Tab } from '../src/tab';

/**
 * These tests pin the call lifecycle across leader handoff — the class behind
 * the June "hub wedge" write-loss legs (HUB-1/SPOKE-2): calls acked by a
 * leader that dies before returning must be re-delivered to its successor
 * instead of orphaning until the call timeout.
 */

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let tabs: Tab[] = [];
let locks: LocksFake;
let names = 0;
let name: string;

function makeTab(options?: { callTimeout?: number }): Tab {
  const tab = new Tab(name, options);
  tabs.push(tab);
  return tab;
}

beforeEach(() => {
  locks = installLocksFake();
  name = `test-${++names}`;
});

afterEach(() => {
  for (const tab of tabs) tab.close();
  tabs = [];
});

describe('Tab calls', () => {
  it('routes a call to the leader and returns its result', async () => {
    const leader = makeTab();
    leader.waitForLeadership(() => ({ math: { double: async (x: number) => x * 2 } }));
    await wait(20);

    const spoke = makeTab();
    await expect(spoke.call('math.double', 21)).resolves.toBe(42);
  });

  it('dispatches calls queued while no leader exists once one is elected', async () => {
    const spoke = makeTab();
    let executions = 0;
    const pending = spoke.call('math.double', 4);
    await wait(20);

    const leader = makeTab();
    leader.waitForLeadership(() => ({
      math: {
        double: async (x: number) => {
          executions++;
          return x * 2;
        },
      },
    }));

    await expect(pending).resolves.toBe(8);
    expect(executions).toBe(1);
  });

  it('re-delivers an acked in-flight call to the next leader when the old one dies (HUB-1)', async () => {
    // Old leader acks the call, then hangs forever executing it.
    const dying = makeTab();
    dying.waitForLeadership(() => ({ svc: { work: () => new Promise(() => {}) } }));
    await wait(20);

    const spoke = makeTab({ callTimeout: 1500 });
    let executions = 0;
    const pending = spoke.call('svc.work');
    await wait(50); // delivered + acked — the 500ms resend loop is cleared

    dying.relinquishLeadership(); // leader death: lock released, call never returns
    const successor = makeTab();
    successor.waitForLeadership(() => ({
      svc: {
        work: async () => {
          executions++;
          return 'recovered';
        },
      },
    }));

    await expect(pending).resolves.toBe('recovered');
    expect(executions).toBe(1);
  });

  it("re-delivers its own in-flight calls to itself when this tab becomes the leader", async () => {
    const dying = makeTab();
    dying.waitForLeadership(() => ({ svc: { work: () => new Promise(() => {}) } }));
    await wait(20);

    const spoke = makeTab({ callTimeout: 1500 });
    const pending = spoke.call('svc.work');
    await wait(50);

    dying.relinquishLeadership();
    spoke.waitForLeadership(() => ({ svc: { work: async () => 'self-recovered' } }));

    await expect(pending).resolves.toBe('self-recovered');
  });

  it('stops the 500ms resend loop once a call times out', async () => {
    // A lock holder that is not a Tab: hasLeader() is true but nothing ever
    // acks, so the resend loop runs until the call times out.
    void (globalThis.navigator as any).locks.request(`tab-${name}`, () => new Promise(() => {}));
    await wait(10);

    const spoke = makeTab({ callTimeout: 1200 });
    await expect(spoke.call('svc.work')).rejects.toThrow('Call timed out');

    // After rejection the loop must be silent: watch the channel for onCall traffic.
    let resends = 0;
    const monitor = new BroadcastChannel(`tab-${name}`);
    monitor.onmessage = e => {
      if (e.data?.name === 'onCall') resends++;
    };
    await wait(700); // > one resend interval
    monitor.close();
    expect(resends).toBe(0);
  });
});

describe('Tab leadership lifecycle', () => {
  it('does not broadcast onLeader when leadership is relinquished during the callback', async () => {
    const monitor = new BroadcastChannel(`tab-${name}`);
    let onLeaderPosts = 0;
    monitor.onmessage = e => {
      if (e.data?.name === 'onLeader') onLeaderPosts++;
    };

    const tab = makeTab();
    await expect(tab.waitForLeadership(relinquish => relinquish())).resolves.toBe(true);
    await wait(20);
    monitor.close();
    expect(onLeaderPosts).toBe(0);
  });

  it('queues calls that arrive while a re-elected leader is still initializing', async () => {
    // Term 1 completes normally, then the same tab re-wins with a slow init;
    // the ready flag from term 1 must not leak into term 2.
    const tab = makeTab();
    const term1 = tab.waitForLeadership(() => ({ svc: { work: async () => 'first' } }));
    await wait(20);
    tab.relinquishLeadership();
    await term1;

    let ready!: (api: any) => void;
    void tab.waitForLeadership(() => new Promise(resolve => (ready = resolve)));
    await wait(20);

    const spoke = makeTab({ callTimeout: 1500 });
    const pending = spoke.call('svc.work');
    await wait(50);

    ready({ svc: { work: async () => 'second' } });
    await expect(pending).resolves.toBe('second');
  });

  it('drops a queued call once it times out instead of executing it on a later leader', async () => {
    const spoke = makeTab({ callTimeout: 100 });
    await expect(spoke.call('svc.work')).rejects.toThrow('Call timed out');

    let executions = 0;
    const leader = makeTab();
    leader.waitForLeadership(() => ({ svc: { work: async () => executions++ } }));
    await wait(50);
    expect(executions).toBe(0);
  });

  it('cancels the has-leader watcher lock request on close', async () => {
    const leader = makeTab();
    leader.waitForLeadership(() => ({}));
    await wait(20);

    const spoke = makeTab();
    await expect(spoke.hasLeader()).resolves.toBe(true);
    expect(locks.pendingCount(`tab-${name}`)).toBe(1);

    spoke.close();
    expect(locks.pendingCount(`tab-${name}`)).toBe(0);
  });


  it('queues calls from two callers with the same call number without collision', async () => {
    // The initializing leader's OWN first call and a spoke's first call are both
    // callNumber 1 in their tabs. Keyed by number alone they collide in the leader's
    // queue, and the loser is then skipped by the own-call re-delivery guard — a
    // spoke-vs-spoke collision self-heals via onLeader re-delivery, but this one
    // orphans until the call timeout.
    let ready!: (api: any) => void;
    const leader = makeTab({ callTimeout: 1500 });
    void leader.waitForLeadership(() => new Promise(resolve => (ready = resolve)));
    await wait(20);

    const own = leader.call('svc.work', 'own');
    const spoke = makeTab({ callTimeout: 1500 });
    const foreign = spoke.call('svc.work', 'foreign');
    await wait(50);

    ready({ svc: { work: async (x: string) => x } });
    await expect(own).resolves.toBe('own');
    await expect(foreign).resolves.toBe('foreign');
  });

  it('surfaces non-cloneable payload errors from setState instead of swallowing them', async () => {
    const tab = makeTab();
    tab.waitForLeadership(() => ({}));
    await wait(20);

    const before = tab.getState();
    let stateEvents = 0;
    tab.addEventListener('state', () => stateEvents++);

    expect(() => tab.setState({ fn: () => {} } as any)).toThrow(/could not be cloned|DataCloneError/);
    // The broadcast must happen before the store, so a state no peer could receive is not left behind.
    expect(tab.getState()).toBe(before);
    expect(stateEvents).toBe(0);
  });
});

describe('Tab postMessage failure paths', () => {
  it('fails only the uncloneable queued call and still forwards the rest to the new leader', async () => {
    // All three queue while there is no leader; the uncloneable one throws mid-sweep in `_onLeader`, and the
    // queued call after it must still reach the new leader.
    const spoke = makeTab({ callTimeout: 1500 });
    const good1 = spoke.call('svc.work', 'a');
    const bad = spoke.call('svc.work', () => {});
    const badResult = bad.then(() => null, e => e);
    const good2 = spoke.call('svc.work', 'c');
    await wait(20);

    const leader = makeTab();
    leader.waitForLeadership(() => ({ svc: { work: async (x: string) => x } }));

    await expect(good1).resolves.toBe('a');
    await expect(good2).resolves.toBe('c');
    expect((await badResult)?.message).toMatch(/could not be cloned|DataCloneError/);
  });

  it('rejects a call with an uncloneable argument immediately instead of at the timeout', async () => {
    const leader = makeTab();
    leader.waitForLeadership(() => ({ svc: { work: async (x: any) => x } }));
    await wait(20);

    const spoke = makeTab({ callTimeout: 5000 });
    const started = Date.now();
    await expect(spoke.call('svc.work', () => {})).rejects.toThrow(/could not be cloned|DataCloneError/);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('Tab close', () => {
  it('reports no leader and rejects calls once closed', async () => {
    const leader = makeTab();
    leader.waitForLeadership(() => ({ svc: { work: async () => 'ok' } }));
    await wait(20);

    const spoke = makeTab({ callTimeout: 5000 });
    await expect(spoke.hasLeader()).resolves.toBe(true);

    spoke.close();
    await expect(spoke.hasLeader()).resolves.toBe(false);

    const started = Date.now();
    await expect(spoke.call('svc.work')).rejects.toThrow('Tab is closed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('does not resurrect its channel when something posts after close', async () => {
    const tab = makeTab();
    tab.close();
    const channel = (tab as any)._channel;

    expect(() => tab.send('anyone there?')).not.toThrow();
    expect((tab as any)._channel).toBe(channel);
    expect(channel.onmessage).toBe(null);
  });
});
