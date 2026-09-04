import type { EvaluationTelemetry, Ruleset } from "@coduck/flags-core";

export interface FlagSourceHandlers {
  /** Returns true only when the runtime accepted the snapshot. */
  onSnapshot(snapshot: unknown): boolean;
  onHealthy(): void;
  onError(error: Error): void;
}

export interface FlagSourceConnection {
  close(): void;
  refresh(): Promise<void>;
}

export interface FlagSource {
  readonly kind: string;
  connect(handlers: FlagSourceHandlers): FlagSourceConnection;
}

export interface RulesetCache {
  load(): Promise<unknown | undefined>;
  save(ruleset: Ruleset): Promise<void>;
}

export interface FlagClientStatus {
  ready: boolean;
  closed: boolean;
  stale: boolean;
  source?: string;
  environment?: string;
  revision?: number;
  updatedAt?: string;
  lastConfirmedAt?: string;
  ageMs?: number;
}

export interface FlagClientOptions {
  source: FlagSource;
  environment?: string;
  bootstrap?: unknown;
  cache?: RulesetCache;
  staleAfterMs?: number;
  onError?: (error: Error) => void;
  /** Deliberately excludes targeting keys and context attributes. */
  onEvaluation?: (event: EvaluationTelemetry) => void;
}

export interface FlagClientEvents {
  ready: FlagClientStatus;
  update: FlagClientStatus;
  stale: FlagClientStatus;
  healthy: FlagClientStatus;
  error: Error;
  evaluation: EvaluationTelemetry;
  close: FlagClientStatus;
}
