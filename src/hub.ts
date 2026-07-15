import { Tab } from './tab.js';

/**
 * `instanceof SharedWorker` THROWS when the global is undefined (Samsung
 * Internet has no SharedWorker; neither do some worker/test contexts), so all
 * worker-kind checks go through these typeof-guarded helpers.
 */
function isSharedWorker(worker: unknown): worker is SharedWorker {
  return typeof SharedWorker !== 'undefined' && worker instanceof SharedWorker;
}

function isDedicatedWorker(worker: unknown): worker is Worker {
  return typeof Worker !== 'undefined' && worker instanceof Worker;
}

/**
 * Hub & Spoke Multi-Tab Coordination Utility
 *
 * This utility provides a simple way to coordinate multiple browser tabs using a hub-and-spoke
 * architecture where one tab (or shared worker) acts as the central hub that manages shared
 * resources like databases and server connections, while other tabs (spokes) communicate with
 * the hub to access these resources.
 *
 * Key features:
 * - Automatic leadership election using tab-election
 * - Type-safe RPC between spokes and hub services
 * - Optional version mismatch detection and handling
 * - Support for SharedWorker, WebWorker, or in-tab coordination
 * - Flexible service registration and service stub generation
 *
 * @example
 * ```typescript
 * // Define event types for your service
 * interface DatabaseEvents {
 *   'user-saved': { user: User };
 *   'user-deleted': { id: string };
 * }
 *
 * // Define a service class with phantom property for type inference
 * class DatabaseService {
 *   readonly namespace = 'db' as const;
 *   readonly __events?: DatabaseEvents;  // Phantom property - don't set at runtime
 *   private db: IDBDatabase;
 *   private hub: Hub;
 *
 *   async init(hub: Hub): Promise<void> {
 *     this.hub = hub;
 *     this.db = await openDB(`app-${hub.name}`);
 *   }
 *
 *   async getUser(id: string): Promise<User> {
 *     // Database operations...
 *   }
 *
 *   async saveUser(user: User): Promise<void> {
 *     // Database operations...
 *     this.hub.emit(this.namespace, 'user-saved', { user }); // Type-safe event emission
 *   }
 * }
 *
 * // Hub setup (in shared worker or elected tab)
 * const hub = new Hub((hub) => {
 *   hub.register(new DatabaseService());
 *   hub.register(new AuthenticationService());
 * });
 * hub.onVersionMismatch((oldVersion, newVersion) => {
 *   console.log(`Version updated: ${oldVersion} -> ${newVersion}`);
 *   return 'refresh'; // or 'ignore'
 * });
 *
 * // Spoke setup (in each tab)
 * const spoke = new Spoke({
 *   workerUrl: 'hub.js',
 *   name: 'user-123',
 *   version: '1.0.0'
 * });
 * const db = spoke.getService<DatabaseService>('db');
 * const user = await db.getUser('123'); // Fully typed!
 *
 * // Listen for events from the service - fully typed!
 * const unsubscribe = db.on('user-saved', ({ user }) => {
 *   console.log('User was saved:', user);
 * });
 *
 * // TypeScript will error on invalid event names or payloads:
 * // db.on('invalid-event', () => {}); // Error: invalid event name
 * // db.on('user-saved', ({ wrongProp }) => {}); // Error: wrong payload shape
 * ```
 */

// Types and Interfaces

/**
 * Event listener function type.
 */
export type EventListener<T = unknown> = (payload: T) => void;

/**
 * Unsubscribe function type.
 */
export type UnsubscribeFunction = () => void;

/**
 * Base service interface that hub services should implement.
 *
 * `Events` is a mapping from event names (string keys) to the payload type that will be
 * delivered to listeners. By default it is an empty map meaning the service does not
 * emit any strongly-typed events.
 *
 * @example
 * ```typescript
 * interface UserEvents {
 *   "user-saved": { user: User };
 *   "user-deleted": { id: string };
 * }
 *
 * class DatabaseService {
 *   readonly namespace = "db" as const;
 *   readonly __events?: UserEvents;  // Phantom property for type inference
 *
 *   async saveUser(user: User): Promise<void> {
 *     // ... save logic
 *     // Emit via hub.emit(this.namespace, 'user-saved', { user })
 *   }
 * }
 * ```
 */
export interface Service<Events extends Record<string, any> = {}> {
  readonly namespace: string;
  readonly __events?: Events;

  /**
   * Initialize the service.
   * This is called once when the service is first instantiated in the hub.
   */
  init?(hub: Hub): Promise<void> | void;

  /**
   * Close the service.
   * This is called when the service is no longer needed.
   */
  close?(): void;
}

// Extract the event map from a Service implementation
type ServiceEvents<T> = T extends Service<infer E> ? E : never;

/**
 * Service stub type - a proxy for calling methods on a remote Service with type-safe events.
 */
export type ServiceStub<T extends Service<any>> = AllMethodsAsync<Omit<T, 'init' | 'close' | '__events'>> & {
  on<K extends keyof ServiceEvents<T>>(eventName: K, listener: EventListener<ServiceEvents<T>[K]>): UnsubscribeFunction;
};

/**
 * @deprecated Use `ServiceStub<T>` instead. This alias will be removed in a future major version.
 */
export type Client<T extends Service<any>> = ServiceStub<T>;

/**
 * Configuration options for creating a Hub.
 */
export interface HubOptions {
  /** Unique name/namespace for this hub instance (e.g., 'user-123', 'session-abc') */
  name?: string;
  /** Optional version string for version mismatch detection */
  version?: string;
}

/**
 * Configuration options for creating a Spoke.
 */
export interface SpokeOptions {
  /** URL of the worker script that runs the hub, or a Hub instance for an in-tab hub (will still only be one active hub per name/version) */
  workerUrl: string | Hub;
  /** Unique name/namespace to connect to (must match hub name) */
  name: string;
  /** Optional version string for version mismatch detection */
  version?: string;
  /** Whether to use SharedWorker when available */
  useSharedWorker?: boolean;
  /** How long a service call waits for a return before rejecting with `Error('Call timed out')`. Default 30s. */
  callTimeout?: number;
  /** Minimum delay between fruitless worker recoveries (ms). Doubles per fruitless recovery. Default 10s. */
  recoveryBackoffMinMs?: number;
  /** Ceiling for the recovery backoff (ms). Default 5 minutes. */
  recoveryBackoffMaxMs?: number;
  /** Fruitless recoveries (no heartbeat between them) before `onRecoveryFailed` fires. Default 5. */
  maxFruitlessRecoveries?: number;
}

/**
 * Why a spoke recovered its hub worker: heartbeats stopped ('heartbeat'),
 * service calls kept timing out while heartbeats continued ('call-stall'), or
 * the worker fired an 'error' event before ever producing a heartbeat
 * ('boot-failure' — e.g. its module script failed to fetch or parse).
 */
export type RecoveryReason = 'heartbeat' | 'call-stall' | 'boot-failure';

export interface RecoveryEvent {
  reason: RecoveryReason;
  attempt: number;
}

/**
 * Fired once per wedge episode when repeated worker recoveries never produce
 * a heartbeat — the worker is not coming back on its own (the classic cause: a
 * deploy purged the old hashed worker script, so every respawn re-fetches a
 * URL that no longer serves JavaScript). The app should escalate: surface the
 * failure and, when it cannot lose user data, reload onto fresh assets.
 * Recovery attempts continue at the backoff ceiling after this fires.
 */
export interface RecoveryFailedEvent {
  /** Consecutive recoveries without a single heartbeat in between. */
  attempts: number;
  /** Message from the last worker 'error' event, when one fired (e.g. a failed script fetch). */
  lastError?: string;
}

/**
 * Function signature for version mismatch handlers.
 */
export type VersionMismatchHandler = (oldVersion: string, newVersion: string) => void;

/**
 * Utility type to convert all methods to async methods for RPC.
 */
type AllMethodsAsync<T> = {
  [K in keyof T as T[K] extends (...args: any[]) => any ? K : never]: T[K] extends (...args: any[]) => Promise<any>
  ? T[K]
  : T[K] extends (...args: infer P) => infer R
  ? (...args: P) => Promise<R>
  : never;
};

class Leader {

  constructor(public hub: Hub, public readonly services: Map<string, Service>) {
  }

  async init(hub: Hub) {
    for (const service of this.services.values()) {
      if (typeof service.init === 'function') {
        await service.init(hub);
      }
    }
  }

  close() {
    for (const service of this.services.values()) {
      if (typeof service.close === 'function') {
        service.close();
      }
    }
  }
}

export interface Hub {
  addEventListener(type: 'message', listener: (ev: MessageEvent) => any, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => any, options?: boolean | EventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/**
 * Hub class - runs in shared worker or elected tab to manage services and coordination.
 *
 * The Hub is responsible for:
 * - Leadership election among tabs/workers
 * - Service initialization and lifecycle management
 * - RPC method dispatch from spokes to services
 * - Version mismatch detection and handling
 * - Broadcasting updates to connected spokes
 */
export class Hub extends EventTarget {
  protected services = new Map<string, Service>();
  protected tab: Tab;
  protected leader: Leader | null = null;
  protected versionChannel?: BroadcastChannel;
  protected versionMismatchHandlers = new Set<VersionMismatchHandler>();
  protected _name: string;
  protected _version: string;
  protected _isRecovery: boolean;
  protected _heartbeatInterval?: ReturnType<typeof setInterval>;


  /**
   * Create a new Hub instance.
   *
   * @example
   * ```typescript
   * const hub = new Hub((hub) => {
   *   // Initialize the hub when it becomes the leader
   *   hub.register(new DatabaseService());
   *   hub.register(new AuthenticationService());
   * });
   * ```
   */
  constructor(public readonly initialize: (hub: Hub) => Promise<void> | void, name?: string, version?: string) {
    super();
    const parts = name ? [] : self.name.split(':');
    this._name = name || parts[0] || 'default';
    this._version = version || parts[1] || '0.0.0';
    this._isRecovery = !name && !!parts[2];

    // Create tab for leadership election and communication
    this.tab = new Tab(`hub/${this.name}/${this.version}`);

    if (this._name && this._version) {
      // Start leadership election if the name and version were provided, otherwise wait to be set in setOptions
      this.initializeLeadership();
    }
  }

  /**
   * Get the name of the hub.
   */
  get name() {
    return this._name;
  }

  /**
   * Get the version of the hub.
   */
  get version() {
    return this._version;
  }

  /**
   * Whether this hub instance is the elected leader.
   */
  get isLeader(): boolean {
    return this.tab.isLeader;
  }

  /**
   * Change the options of the hub.
   * This will change the name and version of the hub and restart the leadership election.
   *
   * @param options - The new options for the hub
   */
  setOptions(options: Required<HubOptions>) {
    this._name = options.name;
    this._version = options.version;
    this.tab.relinquishLeadership();
    this.tab.close();
    this.tab = new Tab(`hub/${this.name}/${this.version}`);
    this.initializeLeadership();
  }

  /**
   * Register a service with the hub.
   * Services will be instantiated only when this hub becomes the leader.
   *
   * @param service - Instance of the service
   * @example
   * ```typescript
   * hub.register(databaseService);
   * hub.register(authenticationService);
   * ```
   */
  register<T extends Service>(service: T): void {
    this.services.set(service.namespace, service);
  }

  /**
   * Set up version mismatch detection and handling.
   * When called, enables cross-version communication to detect when tabs with different
   * versions are present and allows custom handling of the situation.
   *
   * @param handler - Function to call when version mismatch is detected
   * @example
   * ```typescript
   * hub.onVersionMismatch((oldVersion, newVersion) => {
   *   if (hasUnsavedData()) return 'ignore';
   *   return 'refresh';
   * });
   * ```
   */
  onVersionMismatch(handler: VersionMismatchHandler): UnsubscribeFunction {
    this.versionMismatchHandlers.add(handler);
    this.setupVersionDetection();
    return () => this.versionMismatchHandlers.delete(handler);
  }

  /**
   * Send a message to all connected spokes.
   *
   * @param message - Message to send
   * @example
   * ```typescript
   * hub.send({ type: 'user-updated', userId: '123' });
   * ```
   */
  send(message: any): void {
    this.tab.send(message);
  }

  /**
   * Emit an event to all connected spokes for a service.
   * Events are scoped to the service namespace, so only clients of this specific service will receive them.
   *
   * @param namespace - Namespace of the service to emit the event for
   * @param eventName - Name of the event to emit
   * @param payload - Data to send with the event
   * @example
   * ```typescript
   * hub.emit('db', 'user-updated', { userId: '123', changes: {...} });
   * ```
   */
  emit(namespace: string, eventName: string, payload: unknown): void {
    this.send({
      type: 'service-event',
      namespace,
      eventName,
      payload,
    });
  }

  /**
   * Get the state of the hub.
   */
  get state(): Record<string, any> {
    return this.tab.getState();
  }

  /**
   * Updates the state of the hub.
   *
   * @param state - State to update
   * @example
   * ```typescript
   * hub.setState({ connected: true });
   * ```
   */
  updateState(state: Record<string, any>): void {
    const currentState = this.tab.getState();
    this.tab.setState({ ...currentState, ...state });
  }

  /**
   * Close the hub and clean up resources.
   */
  close(): void {
    clearInterval(this._heartbeatInterval);
    this.tab.close();
    this.leader?.close();
    this.leader = null;
    this.versionChannel?.close();
  }

  protected async initializeLeadership() {
    this.tab.addEventListener('leadershipchange', () => {
      const data = { type: 'tab-election:leadership', isLeader: this.tab.isLeader };
      // In a dedicated worker, notify the parent tab via postMessage
      if (typeof window === 'undefined' && 'postMessage' in self) {
        (self as any).postMessage(data);
      }
      // Dispatch locally for in-tab Hub case (Spoke listens via addEventListener)
      this.dispatchEvent(new MessageEvent('message', { data }));
    });

    await this.tab.waitForLeadership(async () => {
      await this.initialize(this);
      this.leader = new Leader(this, this.services);
      await this.leader.init(this);
      this._heartbeatInterval = setInterval(() => {
        this.send({ type: 'tab-election:heartbeat' });
      }, 2000);
      return Object.fromEntries(this.leader.services.entries());
    }, { steal: this._isRecovery });

    clearInterval(this._heartbeatInterval);
    if (this.leader) {
      this.leader.close();
      this.leader = null;
    }
  }

  protected setupVersionDetection(): void {
    if (this.versionChannel) return;

    // Use version-agnostic channel name for cross-version communication
    this.versionChannel = new BroadcastChannel(`hub-version-${this.name}`);

    // Listen for other hub versions starting up
    this.versionChannel.addEventListener('message', event => {
      const { version: otherVersion } = event.data;
      if (otherVersion !== this.version && this.versionMismatchHandlers.size > 0) {
        this.versionMismatchHandlers.forEach(handler => handler(this.version, otherVersion));
      }
    });

    // Announce this hub's version
    this.versionChannel.postMessage({ version: this.version });
  }
}

/**
 * Spoke class - runs in browser tabs to communicate with the hub.
 *
 * The Spoke is responsible for:
 * - Connecting to the hub (via worker or tab communication)
 * - Providing type-safe service client proxies
 * - Handling worker lifecycle (creation, communication)
 * - Forwarding RPC calls to hub services
 */
export class Spoke {
  protected tab: Tab;
  protected worker?: Worker | SharedWorker | Hub;
  protected stubs = new Map<string, ServiceStub<Service>>();
  protected onStateListeners = new Set<EventListener<Record<string, any>>>();
  protected onLeaderChangeListeners = new Set<EventListener<boolean>>();
  protected _isLeader = false;
  protected _workerUrl?: string;
  protected _recoveryAttempt = 0;
  protected _heartbeatTimeout?: ReturnType<typeof setTimeout>;
  protected _lastHeartbeat = 0;
  /**
   * Consecutive `Call timed out` rejections per `namespace.method`, NOT per
   * spoke. A hub can wedge on ONE code path while every other path stays
   * responsive — the observed shape is a hub whose write loop has starved
   * while its RPC dispatcher still answers cheap reads. A single spoke-wide
   * counter cannot see that: any successful call anywhere zeroes it, and a
   * real app is always chattering on something (presence leases, tab pings,
   * liveness probes), so the wedged path's timeouts never accumulate and the
   * worker is never respawned. Keying by method lets a starved path reach the
   * threshold on its own evidence while healthy traffic flows past it.
   */
  protected _consecutiveCallTimeouts = new Map<string, number>();
  protected onRecoveryListeners = new Set<EventListener<RecoveryEvent>>();
  protected onRecoveryFailedListeners = new Set<EventListener<RecoveryFailedEvent>>();
  /** When the last worker recovery ran — the base the backoff gate measures from. */
  protected _lastRecoverAt = 0;
  /** Recoveries since the last heartbeat; >0 means the episode is so far fruitless. */
  protected _recoveriesSinceHeartbeat = 0;
  /** Whether any heartbeat has arrived since the current worker spawned. */
  protected _heartbeatSinceSpawn = false;
  /** Message from the newest worker 'error' event this episode, for RecoveryFailedEvent. */
  protected _lastWorkerError?: string;
  protected _recoveryFailedFired = false;
  protected _recoveryBackoffMinMs: number;
  protected _recoveryBackoffMaxMs: number;
  protected _maxFruitlessRecoveries: number;

  readonly name: string;
  readonly version?: string;

  /**
   * Create a new Spoke instance.
   *
   * @param options - Configuration options for the spoke
   * @example
   * ```typescript
   * const spoke = new Spoke({
   *   workerUrl: 'hub.js',
   *   name: 'user-123',
   *   version: '1.0.0'
   * });
   * ```
   */
  constructor(options: SpokeOptions) {
    this.name = options.name || 'default';
    this.version = options.version || '0.0.0';
    this._recoveryBackoffMinMs = options.recoveryBackoffMinMs ?? 10_000;
    this._recoveryBackoffMaxMs = options.recoveryBackoffMaxMs ?? 300_000;
    this._maxFruitlessRecoveries = options.maxFruitlessRecoveries ?? 5;
    this.tab = new Tab(`hub/${this.name}/${this.version}`, { callTimeout: options.callTimeout });
    this.tab.addEventListener('state', event => {
      this.onStateListeners.forEach(listener => listener(event.data));
    });

    // Determine worker URL with version parameter
    if (options.workerUrl instanceof Hub) {
      this.worker = options.workerUrl;
      this.worker.setOptions({ name: this.name, version: this.version });
    } else {
      this._workerUrl = options.workerUrl;
      // Create worker and tab for communication
      const name = `${this.name}:${this.version}`;
      if (options.useSharedWorker && 'SharedWorker' in globalThis) {
        this.worker = new SharedWorker(options.workerUrl, { type: 'module', name });
      } else if ('Worker' in globalThis) {
        this.worker = new Worker(options.workerUrl, { type: 'module', name });
      } else {
        throw new Error('No worker available in this environment');
      }
    }

    this._attachWorkerListeners(this.worker);

    // Monitor heartbeats from the hub for worker recovery
    if (this._workerUrl) {
      this._startHeartbeatMonitoring();
    }
  }

  /**
   * Attach the per-worker listeners: leadership changes (regular Worker via
   * postMessage, in-tab Hub via EventTarget — SharedWorker is excluded since
   * the spoke doesn't own it) and worker 'error' (real workers only). Called
   * for the initial worker and again for every replacement `_recover` spawns;
   * each listener ignores events once its worker has been replaced.
   */
  protected _attachWorkerListeners(worker: Worker | SharedWorker | Hub): void {
    if (!isSharedWorker(worker)) {
      worker.addEventListener('message', ((e: MessageEvent) => {
        if (worker !== this.worker) return;
        if (e.data?.type === 'tab-election:leadership') {
          this._isLeader = e.data.isLeader;
          this.onLeaderChangeListeners.forEach(l => l(e.data.isLeader));
        }
      }) as EventListener);
    }
    if (isDedicatedWorker(worker) || isSharedWorker(worker)) {
      // A worker whose module script fails to fetch or parse (a deploy purged
      // the old hashed asset, the network is down, a syntax error) never runs
      // a line of code — this 'error' event is the only signal it exists.
      // Best-effort: whether load/MIME failures fire a usable 'error' event
      // (or any message) is browser-dependent. Detection here is only a
      // fast path — a silent boot failure still lands in the backed-off
      // heartbeat-gap recovery, which is the actual thrash guard.
      worker.addEventListener('error', ((e: Event) => {
        if (worker !== this.worker) return;
        const message = (e as ErrorEvent).message;
        this._lastWorkerError = typeof message === 'string' && message ? message : 'worker error event';
        // Only treat it as a boot failure while no heartbeat has arrived since
        // this worker spawned — a runtime error in a live hub is not fatal
        // (call-stall detection owns actual wedges).
        if (!this._heartbeatSinceSpawn && this._workerUrl) {
          this._initiateRecovery('boot-failure');
        }
      }) as EventListener);
    }
  }

  /**
   * Whether this spoke's worker is the elected leader.
   * Always false when using a SharedWorker (the spoke doesn't own it).
   */
  get isLeader(): boolean {
    return this._isLeader;
  }

  /**
   * Get the state of the hub.
   */
  get state(): Record<string, any> {
    return this.tab.getState();
  }

  /**
   * Listen for leadership changes.
   * The listener is called with `true` when this spoke's worker becomes the leader,
   * and `false` when it loses leadership.
   *
   * @param listener - Function to call when leadership changes
   * @returns A function to unsubscribe the listener
   */
  onLeaderChange(listener: EventListener<boolean>): UnsubscribeFunction {
    this.onLeaderChangeListeners.add(listener);
    return () => this.onLeaderChangeListeners.delete(listener);
  }

  /**
   * Listen for state changes on the hub.
   *
   * @param listener - Function to call when state changes
   * @example
   * ```typescript
   * spoke.onState(state => {
   *   console.log('State changed:', state);
   * });
   * ```
   */
  onState(listener: EventListener<Record<string, any>>): UnsubscribeFunction {
    this.onStateListeners.add(listener);
    return () => this.onStateListeners.delete(listener);
  }

  /**
   * Listen for hub worker recoveries initiated by this spoke — either because
   * heartbeats stopped ('heartbeat') or because service calls kept timing out
   * while heartbeats continued ('call-stall', a wedged hub). Useful for
   * telemetry: recoveries should be rare, and a recurring one points at a
   * reproducible hub wedge.
   *
   * @param listener - Function to call when this spoke recovers its worker
   * @returns A function to unsubscribe the listener
   */
  onRecovery(listener: EventListener<RecoveryEvent>): UnsubscribeFunction {
    this.onRecoveryListeners.add(listener);
    return () => this.onRecoveryListeners.delete(listener);
  }

  /**
   * Listen for the terminal recovery signal: repeated worker recoveries have
   * produced no heartbeat, so the worker is not coming back on its own (see
   * {@link RecoveryFailedEvent}). Fires at most once per wedge episode — a
   * later heartbeat closes the episode and re-arms it. The spoke keeps
   * retrying at the backoff ceiling after it fires; the app should escalate
   * (surface the failure, and reload onto fresh assets when that cannot lose
   * user data).
   *
   * @param listener - Function to call when recovery is declared failed
   * @returns A function to unsubscribe the listener
   */
  onRecoveryFailed(listener: EventListener<RecoveryFailedEvent>): UnsubscribeFunction {
    this.onRecoveryFailedListeners.add(listener);
    return () => this.onRecoveryFailedListeners.delete(listener);
  }

  /**
   * Get a type-safe stub for calling methods on a hub service.
   *
   * @param namespace - The namespace of the service to get (must match service's namespace)
   * @returns A proxy object with async versions of all service methods
   * @example
   * ```typescript
   * const db = spoke.getService<DatabaseService>('db');
   * const user = await db.getUser('123'); // Fully typed!
   * await db.saveUser(updatedUser);
   * ```
   */
  getService<T extends Service>(namespace: T['namespace']): ServiceStub<T> {
    if (this.stubs.has(namespace)) {
      return this.stubs.get(namespace) as ServiceStub<T>;
    }

    const on = (eventName: string, listener: EventListener) => {
      const handler = (event: MessageEvent) => {
        if (
          event.data?.type === 'service-event' &&
          event.data?.namespace === namespace &&
          event.data?.eventName === eventName
        ) {
          listener(event.data?.payload);
        }
      };
      this.tab.addEventListener('message', handler);
      return () => this.tab.removeEventListener('message', handler);
    };

    const stub = new Proxy({} as any, {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') {
          throw new Error('Can only call async functions on service stubs');
        }
        if (prop === 'on') {
          return on;
        }
        if (prop === 'then') {
          return undefined;
        }
        return async (...args: any[]) => {
          const method = `${namespace}.${prop as string}`;
          try {
            const result = await this.tab.call(method, ...args);
            this._consecutiveCallTimeouts.delete(method);
            return result;
          } catch (e) {
            // A wedged hub keeps heartbeating (the heartbeat interval is
            // independent of service-call drain), so heartbeat-gap recovery
            // never fires — consecutive call timeouts are the liveness signal
            // for that failure mode.
            if (e instanceof Error && e.message === 'Call timed out') {
              this._noteCallTimeout(method);
            } else {
              // The rejection came back THROUGH the hub, so this path drained —
              // it is as much proof of liveness as a resolved call, but only
              // for this method.
              this._consecutiveCallTimeouts.delete(method);
            }
            throw e;
          }
        };
      },
    }) as ServiceStub<T>;

    this.stubs.set(namespace, stub);
    return stub;
  }

  /**
   * @deprecated Use `getService()` instead. This method will be removed in a future major version.
   */
  client<T extends Service>(namespace: T['namespace']): ServiceStub<T> {
    return this.getService<T>(namespace);
  }

  /**
   * Close the spoke and clean up resources.
   */
  close(): void {
    clearTimeout(this._heartbeatTimeout);
    if (isDedicatedWorker(this.worker)) {
      this.worker.terminate();
    } else if (isSharedWorker(this.worker)) {
      this.worker.port.close();
    } else if (this.worker instanceof Hub) {
      this.worker.close();
    }
  }

  protected _startHeartbeatMonitoring(): void {
    // Randomized timeout between 5-10s per spoke instance
    const timeout = 5000 + Math.random() * 5000;

    this.tab.addEventListener('message', (e: MessageEvent) => {
      if (e.data?.type === 'tab-election:heartbeat') {
        this._lastHeartbeat = Date.now();
        this._heartbeatSinceSpawn = true;
        // A heartbeat means a live hub — whatever episode was running is over.
        this._recoveriesSinceHeartbeat = 0;
        this._recoveryFailedFired = false;
        this._lastWorkerError = undefined;
      } else if (e.data?.type === 'tab-election:recover') {
        if (isSharedWorker(this.worker)) {
          // SharedWorker recovery broadcasts — all spokes must switch together
          this._recover(e.data.attempt, e.data.reason ?? 'heartbeat');
        } else if (isDedicatedWorker(this.worker) && this._isLeader) {
          // Dedicated workers: another spoke detected the leader stalling, and
          // this spoke owns the leader — terminate it so leadership moves.
          this._recover(e.data.attempt, e.data.reason ?? 'heartbeat');
        }
      }
    });

    const check = () => {
      this._heartbeatTimeout = setTimeout(() => {
        // Only trigger recovery after receiving at least one heartbeat
        if (this._lastHeartbeat > 0 && Date.now() - this._lastHeartbeat > timeout) {
          this._initiateRecovery('heartbeat');
        }
        check();
      }, timeout);
    };
    check();
  }

  /**
   * Route a detected hub failure into the right recovery path for the worker
   * mode: SharedWorker recoveries broadcast so every spoke switches together;
   * dedicated-Worker recoveries must happen in the spoke that OWNS the hung
   * leader, so a non-owner broadcasts and the owner acts (see the recover
   * listener above).
   */
  protected _initiateRecovery(reason: RecoveryReason): void {
    const attempt = this._recoveryAttempt + 1;
    if (isSharedWorker(this.worker)) {
      this.tab.send({ type: 'tab-election:recover', attempt, reason });
      this._recover(attempt, reason);
    } else if (isDedicatedWorker(this.worker)) {
      if (this._isLeader || !this._heartbeatSinceSpawn) {
        // Leaders own the hung worker and recover it directly. A spoke whose
        // worker has never been alive since it spawned (no heartbeat — e.g.
        // its script failed to load) also recovers its own: that worker never
        // claimed leadership so there is no owner to broadcast to, and
        // terminating it cannot disturb a live leader.
        this._recover(attempt, reason);
      } else {
        this.tab.send({ type: 'tab-election:recover', attempt, reason });
        // Advance our own attempt too: if the hub wedges again after the
        // owner recovers at this attempt, the next broadcast must carry a
        // higher number or the owner's dedup would ignore it.
        this._recoveryAttempt = attempt;
      }
    }
  }

  protected _noteCallTimeout(method: string): void {
    const timeouts = (this._consecutiveCallTimeouts.get(method) ?? 0) + 1;
    this._consecutiveCallTimeouts.set(method, timeouts);
    // Two consecutive timeouts (~2× callTimeout of unresponsiveness) on the
    // SAME method marks the hub as wedged even though its heartbeat interval —
    // which is independent of service-call drain — keeps firing. One timeout
    // alone may just be a single slow call. The threshold is per-method
    // because a starved path proves the wedge on its own: waiting for the
    // whole spoke to go quiet would mean never recovering a hub that still
    // answers everything except the one thing that matters.
    if (timeouts >= 2 && this._workerUrl) {
      this._consecutiveCallTimeouts.delete(method);
      this._initiateRecovery('call-stall');
    }
  }

  /**
   * Delay required before the next respawn: nothing for the first recovery of
   * an episode, then doubling per fruitless recovery (one that produced no
   * heartbeat) up to the ceiling.
   */
  protected _recoveryBackoffMs(): number {
    if (this._recoveriesSinceHeartbeat === 0) return 0;
    return Math.min(this._recoveryBackoffMinMs * 2 ** (this._recoveriesSinceHeartbeat - 1), this._recoveryBackoffMaxMs);
  }

  protected _recover(attempt: number, reason: RecoveryReason = 'heartbeat'): void {
    if (attempt <= this._recoveryAttempt) return;
    // Pace respawns. A worker that can never come back — its script URL now
    // serves the SPA fallback because a newer deploy purged the old hashed
    // asset — would otherwise be terminated and re-fetched on every heartbeat
    // gap: an infinite ~6/min thrash observed fleet-wide in production
    // (2026-07-14). Skipping leaves `_recoveryAttempt` unchanged so the same
    // attempt re-qualifies once the backoff window has passed.
    if (Date.now() - this._lastRecoverAt < this._recoveryBackoffMs()) return;
    this._recoveryAttempt = attempt;
    this._lastRecoverAt = Date.now();
    this._recoveriesSinceHeartbeat++;
    // Fresh worker: every path starts from a clean slate, not just the one
    // whose timeouts triggered this recovery.
    this._consecutiveCallTimeouts.clear();
    this._heartbeatSinceSpawn = false;
    this.onRecoveryListeners.forEach(l => l({ reason, attempt }));

    if (isSharedWorker(this.worker)) {
      this.worker.port.close();
      // New SharedWorker with recovery suffix — same URL, same version,
      // different worker name so the browser creates a new process.
      // The Hub parses the recovery suffix and uses steal:true on the lock.
      const name = `${this.name}:${this.version}:recover-${attempt}`;
      this.worker = new SharedWorker(this._workerUrl!, { type: 'module', name });
      this._attachWorkerListeners(this.worker);
    } else if (isDedicatedWorker(this.worker)) {
      this.worker.terminate();
      // New Worker — lock was released by terminate, another tab's worker
      // or this new one will take leadership naturally.
      const name = `${this.name}:${this.version}`;
      this.worker = new Worker(this._workerUrl!, { type: 'module', name });
      this._attachWorkerListeners(this.worker);
    }

    if (this._recoveriesSinceHeartbeat > this._maxFruitlessRecoveries && !this._recoveryFailedFired) {
      this._recoveryFailedFired = true;
      const event: RecoveryFailedEvent = { attempts: this._recoveriesSinceHeartbeat };
      if (this._lastWorkerError !== undefined) event.lastError = this._lastWorkerError;
      this.onRecoveryFailedListeners.forEach(l => l(event));
    }
  }
}
