import { evaluateFlag, RulesetValidationError, validateRuleset } from "@coduckai/flags-core";
import type {
  EvaluationContext,
  EvaluationDetails,
  EvaluationTelemetry,
  JsonValue,
  Ruleset
} from "@coduckai/flags-core";
import type {
  FlagClientEvents,
  FlagClientOptions,
  FlagClientStatus,
  FlagSourceConnection
} from "./contracts.js";

type Listener<T> = (event: T) => void;

export class FlagClient {
  private snapshot?: Ruleset;
  private snapshotText?: string;
  private sourceName?: string;
  private lastConfirmedAt?: number;
  private connection?: FlagSourceConnection;
  private closed = false;
  private stale = false;
  private readonly listeners = new Map<keyof FlagClientEvents, Set<Listener<never>>>();
  private readonly readinessWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private readonly staleTimer: ReturnType<typeof setInterval>;
  private readonly initialization: Promise<void>;
  private cacheWrite: Promise<void> = Promise.resolve();

  constructor(private readonly options: FlagClientOptions) {
    const staleAfterMs = options.staleAfterMs ?? 90_000;
    if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
      throw new TypeError("staleAfterMs must be a positive finite number");
    }
    this.staleTimer = setInterval(
      () => this.checkStaleness(),
      Math.min(Math.max(Math.floor(staleAfterMs / 2), 10), 1_000)
    );
    this.staleTimer.unref?.();
    if (options.bootstrap !== undefined) this.acceptSnapshot(options.bootstrap, "bootstrap");
    this.initialization = this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.options.cache) {
      try {
        const cached = await this.options.cache.load();
        if (!this.closed && cached !== undefined) this.acceptSnapshot(cached, "cache", true);
      } catch (error) {
        this.reportError(error);
      }
    }
    if (this.closed) return;
    try {
      this.connection = this.options.source.connect({
        onSnapshot: (snapshot) => this.acceptSnapshot(snapshot, this.options.source.kind),
        onHealthy: () => this.confirmHealthy(),
        onError: (error) => this.reportError(error)
      });
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.closed) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.emit("error", normalized);
    try {
      this.options.onError?.(normalized);
    } catch {
      // An application's observer must never affect flag evaluation or refresh.
    }
  }

  private rejectSnapshot(error: Error): false {
    if (!this.stale) {
      this.stale = true;
      this.emit("stale", this.getStatus());
    }
    this.reportError(error);
    return false;
  }

  private acceptSnapshot(input: unknown, source: string, ignoreOlder = false): boolean {
    if (this.closed) return false;
    const result = validateRuleset(input);
    if (!result.valid) {
      return this.rejectSnapshot(new RulesetValidationError(result.issues));
    }
    const next = result.value;
    if (this.options.environment && next.environment !== this.options.environment) {
      return this.rejectSnapshot(
        new Error(`Expected environment ${this.options.environment}; received ${next.environment}`)
      );
    }
    if (this.snapshot && this.snapshot.environment !== next.environment) {
      return this.rejectSnapshot(
        new Error("A client cannot switch environments after initialization")
      );
    }
    const nextText = JSON.stringify(next);
    if (this.snapshot && next.revision < this.snapshot.revision) {
      if (!ignoreOlder)
        this.reportError(
          new Error(
            `Ignored stale revision ${next.revision}; current revision is ${this.snapshot.revision}`
          )
        );
      return false;
    }
    if (this.snapshot && next.revision === this.snapshot.revision) {
      if (nextText !== this.snapshotText) {
        return this.rejectSnapshot(
          new Error(`Revision ${next.revision} changed without a revision increment`)
        );
      } else if (source !== "cache" && source !== "bootstrap") {
        this.sourceName = source;
        this.confirmHealthy();
      }
      return true;
    }

    const wasReady = this.snapshot !== undefined;
    this.snapshot = next;
    this.snapshotText = nextText;
    this.sourceName = source;
    if (source === "cache") {
      // A cache is safe to serve but cannot prove that the control plane is reachable or current.
      this.lastConfirmedAt = undefined;
      this.stale = true;
    } else {
      this.confirmHealthy();
    }
    if (this.options.cache && source !== "cache" && source !== "bootstrap") {
      this.cacheWrite = this.cacheWrite
        .then(() => this.options.cache?.save(next))
        .then(() => undefined)
        .catch((error: unknown) => this.reportError(error));
    }
    if (!wasReady) {
      for (const waiter of this.readinessWaiters) waiter.resolve();
      this.readinessWaiters.clear();
      this.emit("ready", this.getStatus());
    }
    this.emit("update", this.getStatus());
    return true;
  }

  private confirmHealthy(): void {
    if (this.closed) return;
    const wasStale = this.stale;
    this.lastConfirmedAt = Date.now();
    this.stale = false;
    if (wasStale) this.emit("healthy", this.getStatus());
  }

  private checkStaleness(): void {
    if (this.closed || !this.snapshot || this.lastConfirmedAt === undefined) return;
    if (!this.stale && Date.now() - this.lastConfirmedAt >= (this.options.staleAfterMs ?? 90_000)) {
      this.stale = true;
      this.emit("stale", this.getStatus());
    }
  }

  private emit<K extends keyof FlagClientEvents>(event: K, payload: FlagClientEvents[K]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as Listener<FlagClientEvents[K]>)(payload);
      } catch {
        // Observers are isolated from the runtime.
      }
    }
  }

  on<K extends keyof FlagClientEvents>(
    event: K,
    listener: Listener<FlagClientEvents[K]>
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set<Listener<never>>();
    listeners.add(listener as Listener<never>);
    this.listeners.set(event, listeners);
    return () => listeners.delete(listener as Listener<never>);
  }

  evaluate<T extends JsonValue>(
    flagKey: string,
    context: EvaluationContext,
    options: { default: T }
  ): EvaluationDetails<T> {
    const result = evaluateFlag(this.snapshot, flagKey, context, options.default);
    const telemetry: EvaluationTelemetry = {
      flagKey,
      variant: result.variant,
      reason: result.reason,
      errorCode: result.errorCode,
      revision: result.metadata.revision,
      environment: result.metadata.environment
    };
    this.emit("evaluation", telemetry);
    try {
      this.options.onEvaluation?.(telemetry);
    } catch {
      // Telemetry is optional and cannot break application requests.
    }
    return result;
  }

  isEnabled(flagKey: string, context: EvaluationContext, options: { default: boolean }): boolean {
    return this.evaluate(flagKey, context, options).value;
  }

  variant(flagKey: string, context: EvaluationContext, options: { default: string }): string {
    return this.evaluate(flagKey, context, options).value;
  }

  number(flagKey: string, context: EvaluationContext, options: { default: number }): number {
    return this.evaluate(flagKey, context, options).value;
  }

  json<T extends JsonValue[] | { [key: string]: JsonValue }>(
    flagKey: string,
    context: EvaluationContext,
    options: { default: T }
  ): T {
    return this.evaluate(flagKey, context, options).value;
  }

  /** Explicit defaults are also an allowlist: backend-only flag names are never leaked by accident. */
  evaluateMany<T extends Record<string, JsonValue>>(
    defaults: T,
    context: EvaluationContext
  ): { [K in keyof T]: EvaluationDetails<T[K]> } {
    const results = {} as { [K in keyof T]: EvaluationDetails<T[K]> };
    for (const key of Object.keys(defaults) as (keyof T & string)[]) {
      const defaultValue = defaults[key];
      if (defaultValue !== undefined)
        results[key] = this.evaluate(key, context, { default: defaultValue });
    }
    return results;
  }

  getStatus(): FlagClientStatus {
    return {
      ready: this.snapshot !== undefined,
      closed: this.closed,
      stale: this.stale,
      source: this.sourceName,
      environment: this.snapshot?.environment,
      revision: this.snapshot?.revision,
      updatedAt: this.snapshot?.updatedAt,
      lastConfirmedAt:
        this.lastConfirmedAt === undefined
          ? undefined
          : new Date(this.lastConfirmedAt).toISOString(),
      ageMs: this.lastConfirmedAt === undefined ? undefined : Date.now() - this.lastConfirmedAt
    };
  }

  async waitUntilReady(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.closed) throw new Error("Flag client is closed");
    if (this.snapshot) return;
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
      throw new TypeError("timeoutMs must be positive");
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          this.readinessWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.readinessWaiters.delete(waiter);
          reject(error);
        }
      };
      const timer = setTimeout(
        () => waiter.reject(new Error(`Flag client was not ready after ${timeoutMs}ms`)),
        timeoutMs
      );
      this.readinessWaiters.add(waiter);
    });
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    await this.initialization;
    await this.connection?.refresh();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.staleTimer);
    this.connection?.close();
    for (const waiter of this.readinessWaiters)
      waiter.reject(new Error("Flag client closed before becoming ready"));
    this.readinessWaiters.clear();
    await this.initialization;
    await this.cacheWrite;
    this.emit("close", this.getStatus());
    this.listeners.clear();
  }
}

export function createClient(options: FlagClientOptions): FlagClient {
  return new FlagClient(options);
}
