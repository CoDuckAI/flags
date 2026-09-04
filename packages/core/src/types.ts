export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type FlagType = "boolean" | "string" | "number" | "json";

export type ContextValue = JsonValue | undefined;

export interface EvaluationContext {
  /** Stable subject identifier. Use an account ID when an organization should move together. */
  targetingKey?: string;
  [attribute: string]: ContextValue;
}

export type ConditionOperator =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "contains"
  | "notContains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "notExists";

export interface Condition {
  attribute: string;
  op: ConditionOperator;
  value?: JsonValue;
}

export interface SegmentDefinition {
  conditions: Condition[];
}

export interface TargetDefinition {
  variation: string;
  keys: string[];
}

export interface RolloutSplit {
  variation: string;
  /** Integer weight in basis points. All splits in a rollout must total 10,000. */
  weight: number;
}

export interface RolloutDefinition {
  bucketBy: string;
  salt: string;
  splits: RolloutSplit[];
}

export type RuleServe =
  { variation: string; rollout?: never } | { rollout: RolloutDefinition; variation?: never };

export interface RuleDefinition {
  id: string;
  conditions: Condition[];
  serve: RuleServe;
}

export interface FlagDefinition {
  type: FlagType;
  enabled: boolean;
  variations: Record<string, JsonValue>;
  offVariation: string;
  defaultVariation: string;
  targets: TargetDefinition[];
  rules: RuleDefinition[];
  metadata?: Record<string, JsonValue>;
}

export interface Ruleset {
  schemaVersion: 1;
  revision: number;
  environment: string;
  updatedAt: string;
  segments: Record<string, SegmentDefinition>;
  flags: Record<string, FlagDefinition>;
}

export type ResolutionReason = "DISABLED" | "TARGETING_MATCH" | "SPLIT" | "DEFAULT" | "ERROR";

export type EvaluationErrorCode =
  | "FLAG_NOT_FOUND"
  | "TYPE_MISMATCH"
  | "TARGETING_KEY_MISSING"
  | "INVALID_CONFIGURATION"
  | "GENERAL";

export interface EvaluationDetails<T extends JsonValue = JsonValue> {
  flagKey: string;
  value: T;
  variant?: string;
  reason: ResolutionReason;
  ruleId?: string;
  errorCode?: EvaluationErrorCode;
  errorMessage?: string;
  metadata: {
    environment?: string;
    revision?: number;
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  { valid: true; value: Ruleset } | { valid: false; issues: ValidationIssue[] };

export interface EvaluationTelemetry {
  flagKey: string;
  variant?: string;
  reason: ResolutionReason;
  errorCode?: EvaluationErrorCode;
  revision?: number;
  environment?: string;
}
