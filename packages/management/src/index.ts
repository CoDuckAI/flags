import { assertRuleset } from "@coduck/flags-core";
import type {
  Condition,
  FlagDefinition,
  RuleDefinition,
  Ruleset,
  SegmentDefinition
} from "@coduck/flags-core";

export class ManagementApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "ManagementApiError";
  }
}

export interface ManagementClientOptions {
  url: string;
  adminKey: string;
  requestTimeoutMs?: number;
  allowInsecure?: boolean;
  fetch?: typeof globalThis.fetch;
}

export interface BooleanRolloutOptions {
  environment: string;
  ruleId?: string;
  bucketBy?: string;
  conditions?: Condition[];
  retries?: number;
}

function baseUrl(value: string, allowInsecure = false): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash)
    throw new TypeError("Management URL cannot contain credentials, a query, or a fragment");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (local || allowInsecure))) {
    throw new TypeError("HTTPS is required except for localhost or explicit development use");
  }
  return url.toString().replace(/\/$/, "");
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function booleanVariants(flag: FlagDefinition): { on: string; off: string } {
  if (flag.type !== "boolean") throw new TypeError("Percentage helper requires a boolean flag");
  const on = Object.entries(flag.variations).find(([, value]) => value === true)?.[0];
  const off = Object.entries(flag.variations).find(([, value]) => value === false)?.[0];
  if (!on || !off) throw new TypeError("Boolean flag must declare true and false variations");
  return { on, off };
}

export class ManagementClient {
  private readonly url: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeout: number;

  constructor(private readonly options: ManagementClientOptions) {
    this.url = baseUrl(options.url, options.allowInsecure);
    if (options.adminKey.length < 16)
      throw new TypeError("adminKey must be at least 16 characters");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeout = options.requestTimeoutMs ?? 5_000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0)
      throw new TypeError("requestTimeoutMs must be positive");
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.fetcher(`${this.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.adminKey}`,
        accept: "application/json",
        ...init.headers
      },
      signal: AbortSignal.any([
        AbortSignal.timeout(this.timeout),
        init.signal ?? new AbortController().signal
      ])
    });
    if (!response.ok) {
      const body = await responseBody(response);
      throw new ManagementApiError(
        `Flags management request failed with HTTP ${response.status}`,
        response.status,
        body
      );
    }
    return response;
  }

  async getRuleset(environment: string): Promise<Ruleset> {
    const response = await this.request(`/v1/rulesets/${encodeURIComponent(environment)}`);
    return assertRuleset(await response.json());
  }

  async publishRuleset(ruleset: Ruleset, expectedRevision: number | null): Promise<Ruleset> {
    const validated = assertRuleset(ruleset);
    const response = await this.request(
      `/v1/rulesets/${encodeURIComponent(validated.environment)}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(expectedRevision === null
            ? { "if-none-match": "*" }
            : { "if-match": `"${expectedRevision}"` })
        },
        body: JSON.stringify(validated)
      }
    );
    return assertRuleset(await response.json());
  }

  async createEnvironment(input: {
    environment: string;
    flags?: Record<string, FlagDefinition>;
    segments?: Record<string, SegmentDefinition>;
  }): Promise<Ruleset> {
    return this.publishRuleset(
      assertRuleset({
        schemaVersion: 1,
        revision: 1,
        environment: input.environment,
        updatedAt: new Date().toISOString(),
        segments: input.segments ?? {},
        flags: input.flags ?? {}
      }),
      null
    );
  }

  async update(
    environment: string,
    mutation: (draft: Ruleset) => void,
    options: { retries?: number } = {}
  ): Promise<Ruleset> {
    const retries = options.retries ?? 2;
    if (!Number.isSafeInteger(retries) || retries < 0) {
      throw new TypeError("retries must be a non-negative safe integer");
    }
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const current = await this.getRuleset(environment);
      const next = copy(current);
      mutation(next);
      next.revision = current.revision + 1;
      next.updatedAt = new Date().toISOString();
      try {
        return await this.publishRuleset(assertRuleset(next), current.revision);
      } catch (error) {
        if (!(error instanceof ManagementApiError) || error.status !== 409 || attempt === retries)
          throw error;
      }
    }
    throw new Error("Unreachable management update state");
  }

  setEnabled(environment: string, flagKey: string, enabled: boolean): Promise<Ruleset> {
    return this.update(environment, (draft) => {
      const flag = draft.flags[flagKey];
      if (!flag) throw new TypeError(`Flag ${flagKey} does not exist`);
      flag.enabled = enabled;
    });
  }

  setBooleanRollout(
    flagKey: string,
    percentage: number,
    options: BooleanRolloutOptions
  ): Promise<Ruleset> {
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      throw new TypeError("percentage must be between 0 and 100");
    }
    const rawBasisPoints = percentage * 100;
    const basisPoints = Math.round(rawBasisPoints);
    if (Math.abs(rawBasisPoints - basisPoints) > 1e-9) {
      throw new TypeError("percentage supports at most two decimal places");
    }
    const ruleId = options.ruleId ?? "percentage-rollout";
    return this.update(
      options.environment,
      (draft) => {
        const flag = draft.flags[flagKey];
        if (!flag) throw new TypeError(`Flag ${flagKey} does not exist`);
        const { on, off } = booleanVariants(flag);
        const conditions = options.conditions ?? [];
        let rule: RuleDefinition;
        if (basisPoints === 0 || basisPoints === 10_000) {
          rule = { id: ruleId, conditions, serve: { variation: basisPoints === 0 ? off : on } };
        } else {
          rule = {
            id: ruleId,
            conditions,
            serve: {
              rollout: {
                bucketBy: options.bucketBy ?? "targetingKey",
                salt: `${flagKey}:${ruleId}`,
                splits: [
                  { variation: on, weight: basisPoints },
                  { variation: off, weight: 10_000 - basisPoints }
                ]
              }
            }
          };
        }
        const index = flag.rules.findIndex((candidate) => candidate.id === ruleId);
        if (index < 0) flag.rules.push(rule);
        else flag.rules[index] = rule;
      },
      { retries: options.retries }
    );
  }

  setTarget(
    environment: string,
    flagKey: string,
    targetingKey: string,
    variation: string
  ): Promise<Ruleset> {
    if (targetingKey.length === 0) throw new TypeError("targetingKey must not be empty");
    return this.update(environment, (draft) => {
      const flag = draft.flags[flagKey];
      if (!flag) throw new TypeError(`Flag ${flagKey} does not exist`);
      if (!Object.hasOwn(flag.variations, variation))
        throw new TypeError(`Variation ${variation} does not exist`);
      for (const target of flag.targets)
        target.keys = target.keys.filter((key) => key !== targetingKey);
      flag.targets = flag.targets.filter((target) => target.keys.length > 0);
      const target = flag.targets.find((candidate) => candidate.variation === variation);
      if (target) target.keys.push(targetingKey);
      else flag.targets.push({ variation, keys: [targetingKey] });
    });
  }
}

export function createManagementClient(options: ManagementClientOptions): ManagementClient {
  return new ManagementClient(options);
}

export function booleanFlag(
  options: {
    enabled?: boolean;
    default?: boolean;
    metadata?: FlagDefinition["metadata"];
  } = {}
): FlagDefinition {
  const defaultValue = options.default ?? false;
  return {
    type: "boolean",
    enabled: options.enabled ?? true,
    variations: { off: false, on: true },
    offVariation: "off",
    defaultVariation: defaultValue ? "on" : "off",
    targets: [],
    rules: [],
    ...(options.metadata ? { metadata: options.metadata } : {})
  };
}

export type {
  Condition,
  FlagDefinition,
  RuleDefinition,
  Ruleset,
  SegmentDefinition
} from "@coduck/flags-core";
