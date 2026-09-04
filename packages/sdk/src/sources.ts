import { watch } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Ruleset } from "@coduck/flags-core";
import type { FlagSource, FlagSourceHandlers, RulesetCache } from "./contracts.js";

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function staticSource(ruleset: unknown): FlagSource {
  return {
    kind: "static",
    connect(handlers) {
      handlers.onSnapshot(ruleset);
      return {
        close() {},
        async refresh() {
          handlers.onSnapshot(ruleset);
        }
      };
    }
  };
}

export function fileCache(path: string): RulesetCache {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8")) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async save(ruleset: Ruleset) {
      await mkdir(dirname(path), { recursive: true });
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(ruleset)}\n`, { mode: 0o600 });
        await rename(temporaryPath, path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    }
  };
}

export interface FileSourceOptions {
  path: string;
  watch?: boolean;
  pollIntervalMs?: number;
  maxBytes?: number;
}

export function fileSource(options: FileSourceOptions): FlagSource {
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  if (options.path.length === 0) throw new TypeError("path must not be empty");
  for (const [name, value] of Object.entries({ pollIntervalMs, maxBytes })) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  }
  return {
    kind: "file",
    connect(handlers) {
      let closed = false;
      let reading: Promise<void> | undefined;
      let watcher: ReturnType<typeof watch> | undefined;
      const refresh = (): Promise<void> => {
        if (closed) return Promise.resolve();
        if (reading) return reading;
        reading = (async () => {
          try {
            const text = await readFile(options.path, "utf8");
            if (Buffer.byteLength(text) > maxBytes)
              throw new Error("Ruleset file exceeds maxBytes");
            if (!closed) handlers.onSnapshot(JSON.parse(text) as unknown);
          } catch (error) {
            if (!closed) handlers.onError(errorOf(error));
          } finally {
            reading = undefined;
          }
        })();
        return reading;
      };
      void refresh();
      if (options.watch !== false) {
        try {
          watcher = watch(dirname(options.path), (_event, filename) => {
            if (filename === null || filename.toString() === basename(options.path)) void refresh();
          });
          watcher.on("error", (error) => handlers.onError(error));
          watcher.unref();
        } catch (error) {
          handlers.onError(errorOf(error));
        }
      }
      const timer = setInterval(() => void refresh(), pollIntervalMs);
      timer.unref?.();
      return {
        refresh,
        close() {
          closed = true;
          clearInterval(timer);
          watcher?.close();
        }
      };
    }
  };
}

export interface HttpSourceOptions {
  url: string;
  environment: string;
  sdkKey: string;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  stream?: boolean;
  maxBytes?: number;
  allowInsecure?: boolean;
  fetch?: typeof globalThis.fetch;
}

export function validatedBaseUrl(url: string, allowInsecure = false): string {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("Source URL must not contain credentials, a query, or a fragment");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (local || allowInsecure))) {
    throw new TypeError(
      "HTTPS is required except for localhost or explicitly allowed insecure development sources"
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("Ruleset response exceeds maxBytes");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function consumeStream(
  response: Response,
  handlers: FlagSourceHandlers,
  maxBytes: number,
  signal: AbortSignal
): Promise<void> {
  if (!response.body) throw new Error("SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "message";
  let acceptedLatestSnapshot = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maxBytes * 2) throw new Error("SSE frame exceeds maxBytes");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0 && (event === "ruleset" || event === "message")) {
            const payload = data.join("\n");
            if (Buffer.byteLength(payload) > maxBytes)
              throw new Error("SSE ruleset exceeds maxBytes");
            acceptedLatestSnapshot = handlers.onSnapshot(JSON.parse(payload) as unknown);
          }
          data = [];
          event = "message";
          continue;
        }
        if (line.startsWith(":")) {
          if (acceptedLatestSnapshot) handlers.onHealthy();
          continue;
        }
        const separator = line.indexOf(":");
        const field = separator < 0 ? line : line.slice(0, separator);
        const fieldValue = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
        if (field === "event") event = fieldValue;
        if (field === "data") data.push(fieldValue);
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function httpSource(options: HttpSourceOptions): FlagSource {
  const baseUrl = validatedBaseUrl(options.url, options.allowInsecure);
  const endpoint = `${baseUrl}/v1/rulesets/${encodeURIComponent(options.environment)}`;
  const fetcher = options.fetch ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const maxBytes = options.maxBytes ?? 1_048_576;
  if (!options.sdkKey) throw new TypeError("sdkKey must not be empty");
  for (const [name, value] of Object.entries({ pollIntervalMs, requestTimeoutMs, maxBytes })) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  }

  return {
    kind: "http",
    connect(handlers) {
      const controller = new AbortController();
      let etag: string | undefined;
      let refreshing: Promise<void> | undefined;
      const refresh = (): Promise<void> => {
        if (controller.signal.aborted) return Promise.resolve();
        if (refreshing) return refreshing;
        refreshing = (async () => {
          try {
            const response = await fetcher(endpoint, {
              headers: {
                authorization: `Bearer ${options.sdkKey}`,
                accept: "application/json",
                ...(etag ? { "if-none-match": etag } : {})
              },
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeoutMs)])
            });
            if (response.status === 304) {
              handlers.onHealthy();
              return;
            }
            if (!response.ok)
              throw new Error(`Ruleset request failed with HTTP ${response.status}`);
            const text = await readLimited(response, maxBytes);
            if (!controller.signal.aborted) {
              if (handlers.onSnapshot(JSON.parse(text) as unknown)) {
                etag = response.headers.get("etag") ?? undefined;
              }
            }
          } catch (error) {
            if (!controller.signal.aborted) handlers.onError(errorOf(error));
          } finally {
            refreshing = undefined;
          }
        })();
        return refreshing;
      };

      const stream = async (): Promise<void> => {
        let delay = 250;
        while (!controller.signal.aborted) {
          try {
            const response = await fetcher(`${endpoint}/stream`, {
              headers: { authorization: `Bearer ${options.sdkKey}`, accept: "text/event-stream" },
              signal: controller.signal
            });
            if (!response.ok) throw new Error(`Ruleset stream failed with HTTP ${response.status}`);
            if (!response.headers.get("content-type")?.includes("text/event-stream")) {
              throw new Error("Ruleset stream did not return text/event-stream");
            }
            delay = 250;
            await consumeStream(response, handlers, maxBytes, controller.signal);
            if (!controller.signal.aborted) throw new Error("Ruleset stream disconnected");
          } catch (error) {
            if (!controller.signal.aborted) handlers.onError(errorOf(error));
          }
          await wait(delay + Math.floor(Math.random() * delay * 0.2), controller.signal);
          delay = Math.min(delay * 2, 30_000);
        }
      };

      void refresh();
      if (options.stream !== false) void stream();
      const timer = setInterval(() => void refresh(), pollIntervalMs);
      timer.unref?.();
      return {
        refresh,
        close() {
          controller.abort();
          clearInterval(timer);
        }
      };
    }
  };
}
