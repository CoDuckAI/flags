export { createClient, FlagClient } from "./client.js";
export { fileCache, fileSource, httpSource, staticSource, validatedBaseUrl } from "./sources.js";
export type { FileSourceOptions, HttpSourceOptions } from "./sources.js";
export type {
  FlagClientEvents,
  FlagClientOptions,
  FlagClientStatus,
  FlagSource,
  FlagSourceConnection,
  FlagSourceHandlers,
  RulesetCache
} from "./contracts.js";
export type {
  Condition,
  EvaluationContext,
  EvaluationDetails,
  EvaluationTelemetry,
  FlagDefinition,
  JsonValue,
  RuleDefinition,
  Ruleset
} from "@coduck/flags-core";
export { defineRuleset, validateRuleset } from "@coduck/flags-core";
