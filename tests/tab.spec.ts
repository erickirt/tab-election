import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installLocksFake } from './locks-fake';
import { Tab } from '../src/tab';

/**
 * These tests pin the call lifecycle across leader handoff — the class behind
 * the June "hub wedge" write-loss legs (HUB-1/SPOKE-2): calls acked by a
 * leader that dies before returning must be re-delivered to its successor
 * instead of orphaning until the call timeout.
 */

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let tabs: Tab[] = [];
let names = 0;
let name: string;

function makeTab(options?: { callTimeout?: number }): Tab {
  const tab = new Tab(name, options);
  tabs.push(tab);
  return tab;
}

beforeEach(() => {
  installLocksFake();
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
