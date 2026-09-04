import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { assertRuleset } from "@coduck/flags-core";
import type { Ruleset } from "@coduck/flags-core";

export class RevisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionConflictError";
  }
}

export interface RulesetStore {
  get(environment: string): Promise<Ruleset | undefined>;
  put(ruleset: Ruleset, expectedRevision: number | null): Promise<Ruleset>;
  list(): Promise<string[]>;
}

function verifyRevision(
  current: Ruleset | undefined,
  next: Ruleset,
  expectedRevision: number | null
): void {
  if (!current) {
    if (expectedRevision !== null) throw new RevisionConflictError("Environment does not exist");
    if (next.revision !== 1) throw new RevisionConflictError("The first revision must be 1");
    return;
  }
  if (expectedRevision !== current.revision) {
    throw new RevisionConflictError(
      `Expected revision ${expectedRevision}; current revision is ${current.revision}`
    );
  }
  if (next.revision !== current.revision + 1) {
    throw new RevisionConflictError(`Next revision must be ${current.revision + 1}`);
  }
}

export class MemoryRulesetStore implements RulesetStore {
  private readonly rulesets = new Map<string, Ruleset>();

  constructor(initial: Ruleset[] = []) {
    for (const ruleset of initial) {
      const valid = assertRuleset(ruleset);
      if (this.rulesets.has(valid.environment))
        throw new Error(`Duplicate environment ${valid.environment}`);
      this.rulesets.set(valid.environment, valid);
    }
  }

  async get(environment: string): Promise<Ruleset | undefined> {
    return this.rulesets.get(environment);
  }

  async put(input: Ruleset, expectedRevision: number | null): Promise<Ruleset> {
    const next = assertRuleset(input);
    const current = this.rulesets.get(next.environment);
    verifyRevision(current, next, expectedRevision);
    this.rulesets.set(next.environment, next);
    return next;
  }

  async list(): Promise<string[]> {
    return [...this.rulesets.keys()].sort();
  }
}

interface StoreFile {
  schemaVersion: 1;
  environments: Record<string, Ruleset>;
}

export class FileRulesetStore implements RulesetStore {
  private memory = new MemoryRulesetStore();
  private loaded = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Store file must be an object");
      const file = parsed as Partial<StoreFile>;
      if (file.schemaVersion !== 1 || !file.environments || typeof file.environments !== "object") {
        throw new Error("Unsupported flags store format");
      }
      const rulesets = Object.entries(file.environments).map(([environment, input]) => {
        const ruleset = assertRuleset(input);
        if (ruleset.environment !== environment)
          throw new Error("Store environment key does not match its ruleset");
        return ruleset;
      });
      this.memory = new MemoryRulesetStore(rulesets);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }

  private async persist(memory: MemoryRulesetStore): Promise<void> {
    const environments: Record<string, Ruleset> = {};
    for (const environment of await memory.list()) {
      const ruleset = await memory.get(environment);
      if (ruleset) environments[environment] = ruleset;
    }
    const file: StoreFile = { schemaVersion: 1, environments };
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async get(environment: string): Promise<Ruleset | undefined> {
    await this.operation;
    await this.ensureLoaded();
    return this.memory.get(environment);
  }

  async put(ruleset: Ruleset, expectedRevision: number | null): Promise<Ruleset> {
    return this.serialize(async () => {
      await this.ensureLoaded();
      const next = assertRuleset(ruleset);
      verifyRevision(await this.memory.get(next.environment), next, expectedRevision);
      const all: Ruleset[] = [];
      for (const environment of await this.memory.list()) {
        const current = await this.memory.get(environment);
        if (current && environment !== next.environment) all.push(current);
      }
      all.push(next);
      const staged = new MemoryRulesetStore(all);
      await this.persist(staged);
      this.memory = staged;
      return next;
    });
  }

  async list(): Promise<string[]> {
    await this.operation;
    await this.ensureLoaded();
    return this.memory.list();
  }
}
