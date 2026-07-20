import { beforeEach, describe, expect, it } from 'vitest';
import { installLocksFake } from './locks-fake';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let locks: ReturnType<typeof installLocksFake>;

beforeEach(() => {
  locks = installLocksFake();
});

describe('LocksFake', () => {
  it('does not grant a queued waiter while a thief holds the stolen lock', async () => {
    const ran: string[] = [];
    let releaseThief!: () => void;

    void locks.request('L', () => {
      ran.push('holder');
      return new Promise(() => {});
    }).catch(() => {});
    await wait(5);

    void locks.request('L', () => {
      ran.push('waiter');
      return new Promise(() => {});
    });
    await wait(5);

    void locks.request('L', { steal: true } as any, () => {
      ran.push('thief');
      return new Promise<void>(resolve => (releaseThief = resolve));
    });
    await wait(20);

    // The evicted holder must not hand the lock to the waiter behind the thief's back.
    expect(ran).toEqual(['holder', 'thief']);

    releaseThief();
    await wait(20);
    expect(ran).toEqual(['holder', 'thief', 'waiter']);
  });
});
