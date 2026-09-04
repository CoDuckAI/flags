import {
  ErrorCode,
  ProviderNotReadyError,
  ProviderStatus,
  StandardResolutionReasons
} from "@openfeature/server-sdk";
import type {
  EvaluationContext as OpenFeatureContext,
  JsonValue as OpenFeatureJsonValue,
  Logger,
  Provider,
  ResolutionDetails
} from "@openfeature/server-sdk";
import type { EvaluationContext, EvaluationDetails, JsonValue } from "@coduckai/flags";
import { FlagClient } from "@coduckai/flags";

export interface CoDuckProviderOptions {
  readyTimeoutMs?: number;
}

function jsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 32) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const converted = value.map((entry) => jsonValue(entry, depth + 1));
    return converted.every((entry) => entry !== undefined) ? (converted as JsonValue[]) : undefined;
  }
  if (typeof value === "object" && value !== null) {
    const converted: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = jsonValue(entry, depth + 1);
      if (result === undefined) return undefined;
      converted[key] = result;
    }
    return converted;
  }
  return undefined;
}

function context(input: OpenFeatureContext): EvaluationContext {
  const output: EvaluationContext = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "targetingKey") continue;
    const converted = jsonValue(value);
    if (converted !== undefined) output[key] = converted;
  }
  if (input.targetingKey !== undefined) output.targetingKey = input.targetingKey;
  return output;
}

function errorCode(code: EvaluationDetails["errorCode"]): ErrorCode | undefined {
  switch (code) {
    case "FLAG_NOT_FOUND":
      return ErrorCode.FLAG_NOT_FOUND;
    case "TYPE_MISMATCH":
      return ErrorCode.TYPE_MISMATCH;
    case "TARGETING_KEY_MISSING":
      return ErrorCode.TARGETING_KEY_MISSING;
    case "INVALID_CONFIGURATION":
      return ErrorCode.PARSE_ERROR;
    case "GENERAL":
      return ErrorCode.GENERAL;
    case undefined:
      return undefined;
  }
}

function details<T extends JsonValue>(
  client: FlagClient,
  result: EvaluationDetails<T>
): ResolutionDetails<T> {
  const originalReason = result.reason;
  return {
    value: result.value,
    variant: result.variant,
    reason: client.getStatus().stale ? StandardResolutionReasons.STALE : originalReason,
    errorCode: errorCode(result.errorCode),
    errorMessage: result.errorMessage,
    flagMetadata: {
      ...(result.metadata.revision !== undefined ? { revision: result.metadata.revision } : {}),
      ...(result.metadata.environment ? { environment: result.metadata.environment } : {}),
      ...(result.ruleId ? { ruleId: result.ruleId } : {}),
      ...(client.getStatus().stale ? { originalReason } : {})
    }
  };
}

export class CoDuckFlagsProvider implements Provider {
  readonly metadata = { name: "CoDuck Flags" } as const;

  get status(): ProviderStatus {
    const status = this.client.getStatus();
    if (status.closed) return ProviderStatus.ERROR;
    if (!status.ready) return ProviderStatus.NOT_READY;
    if (status.stale) return ProviderStatus.STALE;
    return ProviderStatus.READY;
  }

  constructor(
    private readonly client: FlagClient,
    private readonly options: CoDuckProviderOptions = {}
  ) {}

  async initialize(): Promise<void> {
    try {
      await this.client.waitUntilReady({ timeoutMs: this.options.readyTimeoutMs ?? 5_000 });
    } catch (error) {
      throw new ProviderNotReadyError(
        error instanceof Error ? error.message : "CoDuck Flags is not ready"
      );
    }
  }

  async onClose(): Promise<void> {
    await this.client.close();
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    evaluationContext: OpenFeatureContext,
    _logger: Logger
  ): Promise<ResolutionDetails<boolean>> {
    return details(
      this.client,
      this.client.evaluate(flagKey, context(evaluationContext), { default: defaultValue })
    );
  }

  async resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    evaluationContext: OpenFeatureContext,
    _logger: Logger
  ): Promise<ResolutionDetails<string>> {
    return details(
      this.client,
      this.client.evaluate(flagKey, context(evaluationContext), { default: defaultValue })
    );
  }

  async resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    evaluationContext: OpenFeatureContext,
    _logger: Logger
  ): Promise<ResolutionDetails<number>> {
    return details(
      this.client,
      this.client.evaluate(flagKey, context(evaluationContext), { default: defaultValue })
    );
  }

  async resolveObjectEvaluation<T extends OpenFeatureJsonValue>(
    flagKey: string,
    defaultValue: T,
    evaluationContext: OpenFeatureContext,
    _logger: Logger
  ): Promise<ResolutionDetails<T>> {
    const result = this.client.evaluate(flagKey, context(evaluationContext), {
      default: defaultValue as unknown as JsonValue
    });
    return details(this.client, result) as unknown as ResolutionDetails<T>;
  }
}

export function createOpenFeatureProvider(
  client: FlagClient,
  options?: CoDuckProviderOptions
): CoDuckFlagsProvider {
  return new CoDuckFlagsProvider(client, options);
}
