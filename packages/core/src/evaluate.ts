import { bucketFor } from "./hash.js";
import { flagValueMatchesType } from "./validation.js";
import type {
  Condition,
  EvaluationContext,
  EvaluationDetails,
  FlagDefinition,
  JsonValue,
  ResolutionReason,
  RolloutDefinition,
  Ruleset
} from "./types.js";

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function contextValue(context: EvaluationContext, attribute: string): JsonValue | undefined {
  if (attribute === "targetingKey") return context.targetingKey;
  return hasOwn(context, attribute) ? context[attribute] : undefined;
}

function deepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (Object.is(left, right)) return true;
  if (left === undefined || right === undefined || left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function includesValue(haystack: JsonValue, needle: JsonValue | undefined): boolean {
  if (typeof haystack === "string" && typeof needle === "string") return haystack.includes(needle);
  if (Array.isArray(haystack)) return haystack.some((value) => deepEqual(value, needle));
  return false;
}

function matchRegularCondition(actual: JsonValue | undefined, condition: Condition): boolean {
  const expected = condition.value;
  if (actual === undefined && condition.op !== "notExists") return false;
  switch (condition.op) {
    case "exists":
      return actual !== undefined;
    case "notExists":
      return actual === undefined;
    case "eq":
      return deepEqual(actual, expected);
    case "neq":
      return !deepEqual(actual, expected);
    case "in":
      return Array.isArray(expected) && expected.some((entry) => deepEqual(actual, entry));
    case "notIn":
      return Array.isArray(expected) && !expected.some((entry) => deepEqual(actual, entry));
    case "contains":
      return actual !== undefined && includesValue(actual, expected);
    case "notContains":
      return (
        (typeof actual === "string" || Array.isArray(actual)) && !includesValue(actual, expected)
      );
    case "startsWith":
      return (
        typeof actual === "string" && typeof expected === "string" && actual.startsWith(expected)
      );
    case "endsWith":
      return (
        typeof actual === "string" && typeof expected === "string" && actual.endsWith(expected)
      );
    case "gt":
      return typeof actual === "number" && typeof expected === "number" && actual > expected;
    case "gte":
      return typeof actual === "number" && typeof expected === "number" && actual >= expected;
    case "lt":
      return typeof actual === "number" && typeof expected === "number" && actual < expected;
    case "lte":
      return typeof actual === "number" && typeof expected === "number" && actual <= expected;
  }
}

function matchesSegment(name: string, context: EvaluationContext, ruleset: Ruleset): boolean {
  if (!hasOwn(ruleset.segments, name)) return false;
  const segment = ruleset.segments[name];
  if (!segment) return false;
  return segment.conditions.every((condition) =>
    matchRegularCondition(contextValue(context, condition.attribute), condition)
  );
}

function matchesCondition(
  condition: Condition,
  context: EvaluationContext,
  ruleset: Ruleset
): boolean {
  if (condition.attribute === "$segment") {
    return (
      condition.op === "in" &&
      Array.isArray(condition.value) &&
      condition.value.some(
        (segment) => typeof segment === "string" && matchesSegment(segment, context, ruleset)
      )
    );
  }
  return matchRegularCondition(contextValue(context, condition.attribute), condition);
}

function baseMetadata(ruleset?: Ruleset): EvaluationDetails["metadata"] {
  return ruleset ? { environment: ruleset.environment, revision: ruleset.revision } : {};
}

function failure<T extends JsonValue>(
  flagKey: string,
  defaultValue: T,
  errorCode: EvaluationDetails["errorCode"],
  errorMessage: string,
  ruleset?: Ruleset
): EvaluationDetails<T> {
  return {
    flagKey,
    value: defaultValue,
    reason: "ERROR",
    errorCode,
    errorMessage,
    metadata: baseMetadata(ruleset)
  };
}

function resolved<T extends JsonValue>(
  flagKey: string,
  flag: FlagDefinition,
  variant: string,
  reason: ResolutionReason,
  ruleset: Ruleset,
  ruleId?: string
): EvaluationDetails<T> {
  const value = flag.variations[variant];
  if (value === undefined) {
    throw new Error(`Variation ${variant} is not defined`);
  }
  return {
    flagKey,
    value: value as T,
    variant,
    reason,
    ...(ruleId ? { ruleId } : {}),
    metadata: baseMetadata(ruleset)
  };
}

function rolloutVariant(
  rollout: RolloutDefinition,
  context: EvaluationContext,
  flagKey: string
): string | undefined {
  const rawBucketValue = contextValue(context, rollout.bucketBy);
  if (typeof rawBucketValue !== "string" && typeof rawBucketValue !== "number") return undefined;
  if (typeof rawBucketValue === "number" && !Number.isFinite(rawBucketValue)) return undefined;
  const bucket = bucketFor(rawBucketValue, flagKey, rollout.salt);
  let cursor = 0;
  for (const split of rollout.splits) {
    cursor += split.weight;
    if (bucket < cursor) return split.variation;
  }
  return rollout.splits.at(-1)?.variation;
}

export function evaluateFlag<T extends JsonValue>(
  ruleset: Ruleset | undefined,
  flagKey: string,
  context: EvaluationContext,
  defaultValue: T
): EvaluationDetails<T> {
  try {
    if (!ruleset) {
      return failure(flagKey, defaultValue, "INVALID_CONFIGURATION", "No valid ruleset is loaded");
    }
    const flag = hasOwn(ruleset.flags, flagKey) ? ruleset.flags[flagKey] : undefined;
    if (!flag) {
      return failure(
        flagKey,
        defaultValue,
        "FLAG_NOT_FOUND",
        `Flag ${flagKey} was not found`,
        ruleset
      );
    }
    if (!flagValueMatchesType(flag, defaultValue)) {
      return failure(
        flagKey,
        defaultValue,
        "TYPE_MISMATCH",
        `Caller default does not match flag type ${flag.type}`,
        ruleset
      );
    }
    if (!flag.enabled) {
      return resolved(flagKey, flag, flag.offVariation, "DISABLED", ruleset);
    }

    if (context.targetingKey) {
      for (const target of flag.targets) {
        if (target.keys.includes(context.targetingKey)) {
          return resolved(flagKey, flag, target.variation, "TARGETING_MATCH", ruleset);
        }
      }
    }

    for (const rule of flag.rules) {
      if (!rule.conditions.every((condition) => matchesCondition(condition, context, ruleset)))
        continue;
      if (rule.serve.variation !== undefined) {
        return resolved(flagKey, flag, rule.serve.variation, "TARGETING_MATCH", ruleset, rule.id);
      }
      const variant = rolloutVariant(rule.serve.rollout, context, flagKey);
      if (!variant) {
        return failure(
          flagKey,
          defaultValue,
          "TARGETING_KEY_MISSING",
          `Rollout rule ${rule.id} requires context attribute ${rule.serve.rollout.bucketBy}`,
          ruleset
        );
      }
      return resolved(flagKey, flag, variant, "SPLIT", ruleset, rule.id);
    }

    return resolved(flagKey, flag, flag.defaultVariation, "DEFAULT", ruleset);
  } catch (error) {
    return failure(
      flagKey,
      defaultValue,
      "GENERAL",
      error instanceof Error ? error.message : "Unexpected evaluation error",
      ruleset
    );
  }
}

export function evaluateBoolean(
  ruleset: Ruleset | undefined,
  flagKey: string,
  context: EvaluationContext,
  defaultValue: boolean
): EvaluationDetails<boolean> {
  return evaluateFlag(ruleset, flagKey, context, defaultValue);
}

export function evaluateString(
  ruleset: Ruleset | undefined,
  flagKey: string,
  context: EvaluationContext,
  defaultValue: string
): EvaluationDetails<string> {
  return evaluateFlag(ruleset, flagKey, context, defaultValue);
}

export function evaluateNumber(
  ruleset: Ruleset | undefined,
  flagKey: string,
  context: EvaluationContext,
  defaultValue: number
): EvaluationDetails<number> {
  return evaluateFlag(ruleset, flagKey, context, defaultValue);
}

export function evaluateJson<T extends JsonValue[] | { [key: string]: JsonValue }>(
  ruleset: Ruleset | undefined,
  flagKey: string,
  context: EvaluationContext,
  defaultValue: T
): EvaluationDetails<T> {
  return evaluateFlag(ruleset, flagKey, context, defaultValue);
}
