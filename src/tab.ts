export type OnLeadership = (relinquish: Unsubscribe) => any;
export type Unsubscribe = () => void;
export type OnReceive = (msg: any) => void;
export type OnState<T> = (state: T) => void;

interface Deferred {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  timeout: number;
  /** Method name + args, kept so an in-flight call can be re-delivered when leadership changes. */
  name: string;
  rest: any[];
}

export interface TabOptions {
  /**
   * How long a call waits for a return before rejecting with `Error('Call timed out')`.
   * Default 30s.
   */
  callTimeout?: number;
}

export enum To {
  All = 'all',
  Others = 'others',
  Leader = 'leader',
}

export interface TabEventMap {
  leadershipchange: Event;
  message: MessageEvent;
  state: MessageEvent;
}

export interface Tab {
  addEventListener<K extends keyof TabEventMap>(type: K, listener: (this: BroadcastChannel, ev: TabEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof TabEventMap>(type: K, listener: (this: BroadcastChannel, ev: TabEventMap[K]) => any, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/**
 * A Tab is an interfaces to synchronize state and messages between tabs. It uses BroadcastChannel and the Lock API.
 * This is a simplified version of the original implementation.
 */
export class Tab<T = Record<string, any>> extends EventTarget implements Tab {
  relinquishLeadership = () => {};

  private _name: string;
  private _id: string;
  private _hasLeaderCache: boolean;
  private _hasLeaderChecking: Promise<boolean>;
  private _callerId: string;
  private _callDeferreds = new Map<number, Deferred>();
  private _queuedCalls = new Map<number, { id: string; name: string; rest: any[] }>();
  private _channel: BroadcastChannel;
  private _isLeader = false;
  private _isLeaderReady = false;
  private _state: T;
  private _callCount = 0;
  private _api: any;
  private _sentCalls = new Map<number, any>();
  private _callTimeout: number;
  private _closeAbort = new AbortController();

  constructor(name = 'default', options?: TabOptions) {
    super();
    this._name = name;
    this._id = createTabId();
    this._state = {} as T;
    this._callTimeout = options?.callTimeout ?? 30_000;
    this._createChannel();
    this.hasLeader().then(hasLeader => {
      if (hasLeader) this._postMessage(To.Leader, 'onSendState', this._id);
    });
  }

  get id() {
    return this._id;
  }

  get name() {
    return this._name;
  }

  get isLeader() {
    return this._isLeader;
  }

  hasLeader(): Promise<boolean> {
    if (this._hasLeaderCache || this.isLeader) return Promise.resolve(true);
    if (this._hasLeaderChecking) return this._hasLeaderChecking;

    const check = () => navigator.locks.request(`tab-${this._name}`, { ifAvailable: true }, lock => lock === null);

    return this._hasLeaderChecking = check().then(async (hasLeader) => {
      if (!hasLeader) {
        this._hasLeaderChecking = null;
        return false;
      }

      // bug in Chrome will sometimes handle this option lock request first before running the winner first. This is a
      // workaround to make sure the winner runs first.
      hasLeader = await check();
      this._hasLeaderCache = hasLeader;
      // wait to know when there is no longer a leader; aborted on close so a closed tab doesn't linger in the queue
      navigator.locks
        .request(`tab-${this._name}`, { signal: this._closeAbort.signal }, () => this._hasLeaderCache = false)
        .catch(() => {});
      this._hasLeaderChecking = null;
      return hasLeader;
    });
  }

  getCurrentCallerId() {
    return this._callerId;
  }

  getState() {
    return this._state;
  }
  setState(state: T) {
    if (!this.isLeader) throw new Error('Only the leader can set state');
    this._onState(state);
    this._postMessage(To.Others, 'onState', state);
  }

  async waitForLeadership(onLeadership: OnLeadership, options?: { steal?: boolean }): Promise<boolean> {
    this.relinquishLeadership(); // Cancel any previous leadership requests
    const abortController = new AbortController();
    const { signal } = abortController;
    this.relinquishLeadership = () => abortController.abort('Aborted');

    try {
      // steal: true forcibly takes the lock from the current holder (used for recovery)
      // signal: cancels the lock request before a lock is attained
      const lockOptions: LockOptions = options?.steal ? { steal: true } : { signal };
      return await navigator.locks.request(`tab-${this._name}`, lockOptions, async lock => {
        this._isLeader = true;
        // Never resolve until relinquishLeadership is called
        let relinquished = false;
        const keepLockPromise = new Promise<boolean>(
          resolve =>
            (this.relinquishLeadership = () => {
              relinquished = true;
              resolve(true);
            })
        );
        this._api = await onLeadership(this.relinquishLeadership);
        // If leadership was relinquished during the callback, this tab never actively led: skip ready state, queued
        // call dispatch, and the onLeader broadcast, which would pose this tab's stale state as fresh leader state.
        if (!relinquished) {
          this._isLeaderReady = true;
          const queued = new Set(this._queuedCalls.keys());
          this._queuedCalls.forEach(({ id, name, rest }, callNumber) => this._onCall(id, callNumber, name, ...rest));
          this._queuedCalls.clear();
          // Re-deliver this tab's own calls that were in flight to the previous
          // leader when it died — we are the leader now, so dispatch them to
          // ourselves (see the matching re-delivery for non-leader tabs in
          // `_onLeader`; the same at-least-once caveat applies).
          this._callDeferreds.forEach(({ name, rest }, callNumber) => {
            if (queued.has(callNumber)) return;
            this._clearSentCall(callNumber);
            this._onCall(this._id, callNumber, name, ...rest);
          });
          this.dispatchEvent(new Event('leadershipchange'));
          this._postMessage(To.Others, 'onLeader', this._state);
        }
        return keepLockPromise;
      }).catch(e => e !== 'Aborted' && Promise.reject(e) || false);
    } finally {
      this._isLeader = false;
      this._isLeaderReady = false;
      this._api = null;
      this.dispatchEvent(new Event('leadershipchange'));
    }
  }

  call<R>(name: string, ...rest: any[]): Promise<R> {
    const callNumber = ++this._callCount;
    return new Promise<R>(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this._callDeferreds.delete(callNumber);
        this._queuedCalls.delete(callNumber);
        this._clearSentCall(callNumber);
        reject(new Error('Call timed out'));
      }, this._callTimeout);
      this._callDeferreds.set(callNumber, { resolve, reject, timeout, name, rest });
      const hasLeader = await this.hasLeader();
      if (this.isLeader && this._isLeaderReady) {
        this._onCall(this._id, callNumber, name, ...rest);
      } else if (!this.isLeader && hasLeader) {
        this._sendCall(callNumber, name, rest);
      } else {
        this._queuedCalls.set(callNumber, { id: this._id, name, rest });
      }
    });
  }

  /**
   * Post a call to the leader, re-posting every 500ms until the leader acks it
   * with `callReceived` (a leader that never acks is assumed dead — the resend
   * reaches its successor).
   */
  private _sendCall(callNumber: number, name: string, rest: any[]) {
    const send = () => {
      const t = setTimeout(() => this._sentCalls.has(callNumber) && send(), 500);
      this._sentCalls.set(callNumber, t);
      this._postMessage(To.Leader, 'onCall', this._id, callNumber, name, ...rest);
    };
    send();
  }

  private _clearSentCall(callNumber: number) {
    const t = this._sentCalls.get(callNumber);
    if (t !== undefined) {
      clearTimeout(t);
      this._sentCalls.delete(callNumber);
    }
  }

  send(data: any, to: string | Set<string> = To.Others): void {
    this._postMessage(to, 'onSend', data);
  }

  close(): void {
    this.relinquishLeadership();
    this._closeAbort.abort();
    this._isLeader = false;
    this._channel.close();
    this._channel.onmessage = null;
  }

  _isToMe(to: string | Set<string>, sending?: boolean) {
    if (!to) return false;
    if (typeof to === 'string') {
      // to "All Except [id]" is given as "-[id]", so if it's not me and I'm not sending, return true
      if (to[0] === '-') return to.slice(1) !== this._id && !sending;
      // If we're receiving a message to Others, it is to us, but if we're sending a message to Others, it's not to us
      return (to === To.Leader && this._isLeader) || to === this._id || to === To.All || (to === To.Others && !sending);
    }
    return to.has(this._id);
  }

  _createChannel() {
    this._channel = new BroadcastChannel(`tab-${this._name}`);
    this._channel.onmessage = e => this._onMessage(e);
  }

  _postMessage(to: string | Set<string>, name: string, ...rest: any[]) {
    // Don't send if there's no one to send to
    if (!to || to instanceof Set && !to.size) return;
    const data = { to, name, rest };
    try {
      this._channel.postMessage(data);
    } catch (e) {
      // Only a closed channel is recoverable: recreate it and retry once. Anything else (e.g. DataCloneError when a
      // payload isn't structured-cloneable) must surface to the caller instead of silently dropping the message.
      if (e.name !== 'InvalidStateError') throw e;
      this._createChannel();
      this._channel.postMessage(data);
    }
    if (this._isToMe(to, true)) {
      this._onMessage(new MessageEvent('message', { data }));
    }
  }

  _onMessage(event: MessageEvent) {
    const { to, name, rest } = event.data as { to: Set<string>; name: string; rest: any[] };
    if (!this._isToMe(to)) return;
    if (name === 'onCall') this._onCall.apply(this, rest);
    else if (name === 'callReceived') this._callReceived.apply(this, rest);
    else if (name === 'onReturn') this._onReturn.apply(this, rest);
    else if (name === 'onState') this._onState.apply(this, rest);
    else if (name === 'onSend') this._onSend.apply(this, rest);
    else if (name === 'onSendState') this._onSendState.apply(this, rest);
    else if (name === 'onLeader') this._onLeader.apply(this, rest);
    else console.error('Unknown message', name, rest);
  }

  async _onCall(id: string, callNumber: number, name: string, ...rest: any[]) {
    if (!this.isLeader) return;
    this._postMessage(id, 'callReceived', callNumber);
    if (!this._isLeaderReady) {
      this._queuedCalls.set(callNumber, { id, name, rest });
      return;
    }
    try {
      const parts = name.split('.');
      let fn = parts.pop();
      const target = parts.reduce((acc, part) => acc && acc[part], this._api);
      if (typeof target?.[fn] !== 'function') throw new Error(`Invalid API method "${name}"`);
      this._callerId = id;
      const promise = target[fn](...rest);
      this._callerId = undefined;
      const results = await promise;
      this._postMessage(id, 'onReturn', callNumber, null, results);
    } catch (e) {
      this._callerId = undefined;
      this._postMessage(id, 'onReturn', callNumber, e);
    }
  }

  _callReceived(callNumber: number) {
    this._clearSentCall(callNumber);
  }

  _onReturn(callNumber: number, error: any, results: any) {
    if (this._sentCalls.get(callNumber)) this._callReceived(callNumber);
    const deferred = this._callDeferreds.get(callNumber);
    if (!deferred) return console.error('No deferred found for call', callNumber);
    clearTimeout(deferred.timeout);
    this._callDeferreds.delete(callNumber);
    if (error) deferred.reject(error);
    else deferred.resolve(results);
  }

  _onState(data: T) {
    this._state = data;
    this.dispatchEvent(new MessageEvent('state', { data }));
  }

  _onSend(data: any) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  _onSendState(id: string) {
    if (this.isLeader) {
      this._postMessage(id, 'onState', this._state);
    }
  }

  _onLeader(state: T) {
    this._onState(state);
    const queued = new Set(this._queuedCalls.keys());
    this._queuedCalls.forEach(({ id, name, rest }, callNumber) =>
      this._postMessage(To.Leader, 'onCall', id, callNumber, name, ...rest)
    );
    this._queuedCalls.clear();
    // Re-deliver calls that were IN FLIGHT to the previous leader. The old
    // leader acks `callReceived` before executing, which stops the 500ms
    // resend loop — so a leader that died (or was recovered) after the ack but
    // before returning leaves the call orphaned until its timeout. Any call
    // still pending here that isn't already resending is re-sent to the new
    // leader. Note this makes delivery at-least-once across leader handoff
    // (it already was whenever a `callReceived` ack was lost): handlers whose
    // execution may have completed on the dead leader must be idempotent.
    this._callDeferreds.forEach(({ name, rest }, callNumber) => {
      if (queued.has(callNumber) || this._sentCalls.has(callNumber)) return;
      this._sendCall(callNumber, name, rest);
    });
  }
}

const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function createTabId() {
  let id = '';
  let length = 16;
  while (length--) {
    id += chars[(Math.random() * chars.length) | 0];
  }
  return id;
}
