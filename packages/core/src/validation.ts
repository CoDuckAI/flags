import type {
  Condition,
  ConditionOperator,
  FlagDefinition,
  FlagType,
  JsonValue,
  Ruleset,
  ValidationIssue,
  ValidationResult
} from "./types.js";

const FLAG_TYPES = new Set<FlagType>(["boolean", "string", "number", "json"]);
const OPERATORS = new Set<ConditionOperator>([
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "notExists"
]);
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class RulesetValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(
      `Invalid ruleset:\n${issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n")}`
    );
    this.name = "RulesetValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addUnknownKeyIssues(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({ path: `${path}.${key}`, message: "Unknown property" });
    }
  }
}

function validName(value: unknown): value is string {
  return typeof value === "string" && SAFE_NAME.test(value) && !FORBIDDEN_KEYS.has(value);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonValue(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => !FORBIDDEN_KEYS.has(key) && isJsonValue(entry, depth + 1)
  );
}

function validateCondition(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  allowSegmentReference: boolean
): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Must be an object" });
    return;
  }

  addUnknownKeyIssues(value, new Set(["attribute", "op", "value"]), path, issues);
  const { attribute, op } = value;

  if (typeof attribute !== "string" || attribute.length === 0 || FORBIDDEN_KEYS.has(attribute)) {
    issues.push({ path: `${path}.attribute`, message: "Must be a safe, non-empty string" });
  }
  if (typeof op !== "string" || !OPERATORS.has(op as ConditionOperator)) {
    issues.push({ path: `${path}.op`, message: "Unsupported condition operator" });
    return;
  }

  if (attribute === "$segment") {
    if (!allowSegmentReference) {
      issues.push({
        path: `${path}.attribute`,
        message: "Segments cannot reference other segments"
      });
    }
    if (op !== "in" || !Array.isArray(value.value) || !value.value.every(validName)) {
      issues.push({
        path: `${path}.value`,
        message: "$segment conditions require op=in and an array of segment names"
      });
    }
    return;
  }

  if (op === "exists" || op === "notExists") {
    if (Object.hasOwn(value, "value")) {
      issues.push({ path: `${path}.value`, message: `${op} must not define a value` });
    }
    return;
  }

  if (!Object.hasOwn(value, "value") || !isJsonValue(value.value)) {
    issues.push({ path: `${path}.value`, message: "A valid JSON value is required" });
    return;
  }

  if ((op === "in" || op === "notIn") && !Array.isArray(value.value)) {
    issues.push({ path: `${path}.value`, message: `${op} requires an array` });
  }
  if ((op === "startsWith" || op === "endsWith") && typeof value.value !== "string") {
    issues.push({ path: `${path}.value`, message: `${op} requires a string` });
  }
  if (["gt", "gte", "lt", "lte"].includes(op) && typeof value.value !== "number") {
    issues.push({ path: `${path}.value`, message: `${op} requires a number` });
  }
}

function valueMatchesType(type: FlagType, value: JsonValue): boolean {
  if (type === "json") return typeof value === "object" && value !== null;
  return typeof value === type;
}

function validateFlag(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: "Must be an object" });
    return;
  }

  addUnknownKeyIssues(
    value,
    new Set([
      "type",
      "enabled",
      "variations",
      "offVariation",
      "defaultVariation",
      "targets",
      "rules",
      "metadata"
    ]),
    path,
    issues
  );

  if (typeof value.type !== "string" || !FLAG_TYPES.has(value.type as FlagType)) {
    issues.push({ path: `${path}.type`, message: "Must be boolean, string, number, or json" });
  }
  if (typeof value.enabled !== "boolean") {
    issues.push({ path: `${path}.enabled`, message: "Must be a boolean" });
  }
  if (!isRecord(value.variations) || Object.keys(value.variations).length === 0) {
    issues.push({
      path: `${path}.variations`,
      message: "Must contain at least one named variation"
    });
    return;
  }

  const variationNames = new Set(Object.keys(value.variations));
  for (const [name, variation] of Object.entries(value.variations)) {
    if (!validName(name)) {
      issues.push({ path: `${path}.variations.${name}`, message: "Invalid variation name" });
    }
    if (!isJsonValue(variation)) {
      issues.push({ path: `${path}.variations.${name}`, message: "Must be valid JSON" });
    } else if (typeof value.type === "string" && FLAG_TYPES.has(value.type as FlagType)) {
      if (!valueMatchesType(value.type as FlagType, variation)) {
        issues.push({
          path: `${path}.variations.${name}`,
          message: `Does not match flag type ${value.type}`
        });
      }
    }
  }

  for (const field of ["offVariation", "defaultVariation"] as const) {
    const variation = value[field];
    if (typeof variation !== "string" || !variationNames.has(variation)) {
      issues.push({ path: `${path}.${field}`, message: "Must reference a declared variation" });
    }
  }

  if (!Array.isArray(value.targets)) {
    issues.push({ path: `${path}.targets`, message: "Must be an array" });
  } else {
    value.targets.forEach((target, index) => {
      const targetPath = `${path}.targets[${index}]`;
      if (!isRecord(target)) {
        issues.push({ path: targetPath, message: "Must be an object" });
        return;
      }
      addUnknownKeyIssues(target, new Set(["variation", "keys"]), targetPath, issues);
      if (typeof target.variation !== "string" || !variationNames.has(target.variation)) {
        issues.push({ path: `${targetPath}.variation`, message: "Unknown variation" });
      }
      if (
        !Array.isArray(target.keys) ||
        target.keys.length === 0 ||
        !target.keys.every((key) => typeof key === "string" && key.length > 0)
      ) {
        issues.push({ path: `${targetPath}.keys`, message: "Must contain non-empty string keys" });
      }
    });
  }

  if (value.metadata !== undefined && (!isRecord(value.metadata) || !isJsonValue(value.metadata))) {
    issues.push({ path: `${path}.metadata`, message: "Must be a JSON object" });
  }

  if (!Array.isArray(value.rules)) {
    issues.push({ path: `${path}.rules`, message: "Must be an array" });
    return;
  }

  const ruleIds = new Set<string>();
  value.rules.forEach((rule, index) => {
    const rulePath = `${path}.rules[${index}]`;
    if (!isRecord(rule)) {
      issues.push({ path: rulePath, message: "Must be an object" });
      return;
    }
    addUnknownKeyIssues(rule, new Set(["id", "conditions", "serve"]), rulePath, issues);
    if (!validName(rule.id)) {
      issues.push({ path: `${rulePath}.id`, message: "Must be a valid rule identifier" });
    } else if (ruleIds.has(rule.id)) {
      issues.push({ path: `${rulePath}.id`, message: "Rule identifiers must be unique per flag" });
    } else {
      ruleIds.add(rule.id);
    }

    if (!Array.isArray(rule.conditions)) {
      issues.push({ path: `${rulePath}.conditions`, message: "Must be an array" });
    } else {
      rule.conditions.forEach((condition, conditionIndex) =>
        validateCondition(condition, `${rulePath}.conditions[${conditionIndex}]`, issues, true)
      );
    }

    if (!isRecord(rule.serve)) {
      issues.push({ path: `${rulePath}.serve`, message: "Must be an object" });
      return;
    }
    addUnknownKeyIssues(rule.serve, new Set(["variation", "rollout"]), `${rulePath}.serve`, issues);
    const hasVariation = Object.hasOwn(rule.serve, "variation");
    const hasRollout = Object.hasOwn(rule.serve, "rollout");
    if (hasVariation === hasRollout) {
      issues.push({
        path: `${rulePath}.serve`,
        message: "Must define exactly one of variation or rollout"
      });
      return;
    }

    if (hasVariation) {
      if (typeof rule.serve.variation !== "string" || !variationNames.has(rule.serve.variation)) {
        issues.push({ path: `${rulePath}.serve.variation`, message: "Unknown variation" });
      }
      return;
    }

    const rollout = rule.serve.rollout;
    if (!isRecord(rollout)) {
      issues.push({ path: `${rulePath}.serve.rollout`, message: "Must be an object" });
      return;
    }
    addUnknownKeyIssues(
      rollout,
      new Set(["bucketBy", "salt", "splits"]),
      `${rulePath}.serve.rollout`,
      issues
    );
    if (
      typeof rollout.bucketBy !== "string" ||
      rollout.bucketBy.length === 0 ||
      FORBIDDEN_KEYS.has(rollout.bucketBy)
    ) {
      issues.push({
        path: `${rulePath}.serve.rollout.bucketBy`,
        message: "Must be a safe attribute"
      });
    }
    if (typeof rollout.salt !== "string" || rollout.salt.length === 0) {
      issues.push({
        path: `${rulePath}.serve.rollout.salt`,
        message: "Must be a non-empty string"
      });
    }
    if (!Array.isArray(rollout.splits) || rollout.splits.length === 0) {
      issues.push({ path: `${rulePath}.serve.rollout.splits`, message: "Must not be empty" });
      return;
    }

    let total = 0;
    const splitVariations = new Set<string>();
    rollout.splits.forEach((split, splitIndex) => {
      const splitPath = `${rulePath}.serve.rollout.splits[${splitIndex}]`;
      if (!isRecord(split)) {
        issues.push({ path: splitPath, message: "Must be an object" });
        return;
      }
      addUnknownKeyIssues(split, new Set(["variation", "weight"]), splitPath, issues);
      if (typeof split.variation !== "string" || !variationNames.has(split.variation)) {
        issues.push({ path: `${splitPath}.variation`, message: "Unknown variation" });
      } else if (splitVariations.has(split.variation)) {
        issues.push({ path: `${splitPath}.variation`, message: "Duplicate rollout variation" });
      } else {
        splitVariations.add(split.variation);
      }
      if (!Number.isInteger(split.weight) || (split.weight as number) <= 0) {
        issues.push({ path: `${splitPath}.weight`, message: "Must be a positive integer" });
      } else {
        total += split.weight as number;
      }
    });
    if (total !== 10_000) {
      issues.push({
        path: `${rulePath}.serve.rollout.splits`,
        message: `Weights must total 10000; received ${total}`
      });
    }
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function validateRuleset(input: unknown): ValidationResult {
  try {
    const issues: ValidationIssue[] = [];
    if (!isRecord(input)) {
      return { valid: false, issues: [{ path: "$", message: "Ruleset must be an object" }] };
    }

    addUnknownKeyIssues(
      input,
      new Set(["schemaVersion", "revision", "environment", "updatedAt", "segments", "flags"]),
      "$",
      issues
    );
    if (input.schemaVersion !== 1) {
      issues.push({ path: "$.schemaVersion", message: "Only schemaVersion 1 is supported" });
    }
    if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) {
      issues.push({ path: "$.revision", message: "Must be a positive safe integer" });
    }
    if (!validName(input.environment)) {
      issues.push({ path: "$.environment", message: "Must be a valid environment name" });
    }
    if (
      typeof input.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(input.updatedAt)) ||
      !input.updatedAt.includes("T")
    ) {
      issues.push({ path: "$.updatedAt", message: "Must be an ISO-8601 timestamp" });
    }

    if (!isRecord(input.segments)) {
      issues.push({ path: "$.segments", message: "Must be an object" });
    } else {
      for (const [segmentName, segment] of Object.entries(input.segments)) {
        const segmentPath = `$.segments.${segmentName}`;
        if (!validName(segmentName)) {
          issues.push({ path: segmentPath, message: "Invalid segment name" });
        }
        if (!isRecord(segment)) {
          issues.push({ path: segmentPath, message: "Must be an object" });
          continue;
        }
        addUnknownKeyIssues(segment, new Set(["conditions"]), segmentPath, issues);
        if (!Array.isArray(segment.conditions)) {
          issues.push({ path: `${segmentPath}.conditions`, message: "Must be an array" });
          continue;
        }
        segment.conditions.forEach((condition, index) =>
          validateCondition(condition, `${segmentPath}.conditions[${index}]`, issues, false)
        );
      }
    }

    if (!isRecord(input.flags)) {
      issues.push({ path: "$.flags", message: "Must be an object" });
    } else {
      for (const [flagKey, flag] of Object.entries(input.flags)) {
        const flagPath = `$.flags.${flagKey}`;
        if (!validName(flagKey)) {
          issues.push({ path: flagPath, message: "Invalid flag key" });
        }
        validateFlag(flag, flagPath, issues);
      }
    }

    if (isRecord(input.segments) && isRecord(input.flags)) {
      const segmentNames = new Set(Object.keys(input.segments));
      for (const [flagKey, flag] of Object.entries(input.flags)) {
        if (!isRecord(flag) || !Array.isArray(flag.rules)) continue;
        flag.rules.forEach((rule, ruleIndex) => {
          if (!isRecord(rule) || !Array.isArray(rule.conditions)) return;
          rule.conditions.forEach((condition, conditionIndex) => {
            if (
              !isRecord(condition) ||
              condition.attribute !== "$segment" ||
              !Array.isArray(condition.value)
            )
              return;
            for (const name of condition.value) {
              if (typeof name === "string" && !segmentNames.has(name)) {
                issues.push({
                  path: `$.flags.${flagKey}.rules[${ruleIndex}].conditions[${conditionIndex}].value`,
                  message: `Unknown segment ${name}`
                });
              }
            }
          });
        });
      }
    }

    if (issues.length > 0) return { valid: false, issues };
    const clone = JSON.parse(JSON.stringify(input)) as Ruleset;
    return { valid: true, value: deepFreeze(clone) };
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          path: "$",
          message: error instanceof Error ? error.message : "Unexpected validation error"
        }
      ]
    };
  }
}

export function assertRuleset(input: unknown): Ruleset {
  const result = validateRuleset(input);
  if (!result.valid) throw new RulesetValidationError(result.issues);
  return result.value;
}

export function defineRuleset(ruleset: Ruleset): Ruleset {
  return assertRuleset(ruleset);
}

export function flagValueMatchesType(flag: FlagDefinition, value: JsonValue): boolean {
  return valueMatchesType(flag.type, value);
}

export function conditionOperators(): readonly ConditionOperator[] {
  return [...OPERATORS];
}

export function isValidCondition(value: unknown): value is Condition {
  const issues: ValidationIssue[] = [];
  validateCondition(value, "$", issues, true);
  return issues.length === 0;
}
