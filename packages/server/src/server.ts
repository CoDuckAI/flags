import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { RulesetValidationError, assertRuleset } from "@coduck/flags-core";
import type { Ruleset } from "@coduck/flags-core";
import { MemoryRulesetStore, RevisionConflictError } from "./store.js";
import type { RulesetStore } from "./store.js";

export interface FlagServerOptions {
  store?: RulesetStore;
  readKeys: string[];
  adminKeys: string[];
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  heartbeatMs?: number;
}

export interface StartedFlagServer {
  url: string;
  host: string;
  port: number;
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

function authorized(req: IncomingMessage, keys: string[]): boolean {
  const token = bearer(req);
  return token !== undefined && keys.some((key) => secureEqual(token, key));
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text)),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(text);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > maxBytes)
      throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(buffer);
  }
  if (chunks.length === 0)
    throw Object.assign(new Error("Request body is required"), { statusCode: 400 });
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { statusCode: 400 });
  }
}

function parseExpectedRevision(req: IncomingMessage): number | null | undefined {
  if (req.headers["if-none-match"] === "*") return null;
  const header = req.headers["if-match"];
  if (typeof header !== "string") return undefined;
  const match = /^(?:W\/)?"(\d+)"$/.exec(header.trim());
  return match?.[1] ? Number(match[1]) : undefined;
}

export class FlagServer {
  private readonly store: RulesetStore;
  private readonly clients = new Map<string, Set<ServerResponse>>();
  private server?: Server;
  private heartbeat?: ReturnType<typeof setInterval>;

  constructor(private readonly options: FlagServerOptions) {
    if (options.readKeys.length === 0 || options.adminKeys.length === 0) {
      throw new TypeError("At least one read key and one admin key are required");
    }
    if ([...options.readKeys, ...options.adminKeys].some((key) => key.length < 16)) {
      throw new TypeError("Server keys must be at least 16 characters");
    }
    if (
      options.readKeys.some((readKey) =>
        options.adminKeys.some((adminKey) => secureEqual(readKey, adminKey))
      )
    ) {
      throw new TypeError("Read and admin keys must be distinct");
    }
    const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
      throw new TypeError("maxBodyBytes must be a positive safe integer");
    }
    if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
      throw new TypeError("heartbeatMs must be positive");
    }
    if (
      options.port !== undefined &&
      (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
    ) {
      throw new TypeError("port must be an integer between 0 and 65535");
    }
    if (options.host !== undefined && options.host.length === 0) {
      throw new TypeError("host must not be empty");
    }
    this.store = options.store ?? new MemoryRulesetStore();
  }

  private broadcast(ruleset: Ruleset): void {
    const frame = `event: ruleset\nid: ${ruleset.revision}\ndata: ${JSON.stringify(ruleset)}\n\n`;
    for (const client of this.clients.get(ruleset.environment) ?? []) {
      if (!client.write(frame)) client.destroy(new Error("Slow SSE consumer disconnected"));
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("x-content-type-options", "nosniff");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true });
      return;
    }

    const match = /^\/v1\/rulesets\/([^/]+?)(\/stream)?$/.exec(url.pathname);
    if (!match?.[1]) {
      json(res, 404, { error: "not_found" });
      return;
    }
    let environment: string;
    try {
      environment = decodeURIComponent(match[1]);
    } catch {
      json(res, 400, { error: "invalid_environment" });
      return;
    }
    const stream = match[2] === "/stream";

    if (req.method === "GET") {
      if (!authorized(req, [...this.options.readKeys, ...this.options.adminKeys])) {
        res.setHeader("www-authenticate", "Bearer");
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const ruleset = await this.store.get(environment);
      if (!ruleset) {
        json(res, 404, { error: "environment_not_found" });
        return;
      }
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        res.flushHeaders();
        const clients = this.clients.get(environment) ?? new Set<ServerResponse>();
        clients.add(res);
        this.clients.set(environment, clients);
        res.on("close", () => {
          clients.delete(res);
          if (clients.size === 0) this.clients.delete(environment);
        });
        res.write(`event: ruleset\nid: ${ruleset.revision}\ndata: ${JSON.stringify(ruleset)}\n\n`);
        return;
      }
      const etag = `"${ruleset.revision}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": "no-store" });
        res.end();
        return;
      }
      json(res, 200, ruleset, { etag });
      return;
    }

    if (req.method === "PUT" && !stream) {
      if (!authorized(req, this.options.adminKeys)) {
        res.setHeader("www-authenticate", "Bearer");
        json(res, 401, { error: "unauthorized" });
        return;
      }
      const expectedRevision = parseExpectedRevision(req);
      if (expectedRevision === undefined) {
        json(res, 428, {
          error: "precondition_required",
          message: "Use If-Match or If-None-Match"
        });
        return;
      }
      try {
        const ruleset = assertRuleset(await readJson(req, this.options.maxBodyBytes ?? 1_048_576));
        if (ruleset.environment !== environment) {
          json(res, 400, { error: "environment_mismatch" });
          return;
        }
        const stored = await this.store.put(ruleset, expectedRevision);
        this.broadcast(stored);
        json(res, expectedRevision === null ? 201 : 200, stored, { etag: `"${stored.revision}"` });
      } catch (error) {
        if (error instanceof RevisionConflictError) {
          json(res, 409, { error: "revision_conflict", message: error.message });
        } else if (error instanceof RulesetValidationError) {
          json(res, 400, { error: "invalid_ruleset", issues: error.issues });
        } else {
          const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
          json(res, statusCode, {
            error: statusCode >= 500 ? "internal_error" : "invalid_request",
            ...(statusCode < 500 && error instanceof Error ? { message: error.message } : {})
          });
        }
      }
      return;
    }

    res.setHeader("allow", stream ? "GET" : "GET, PUT");
    json(res, 405, { error: "method_not_allowed" });
  }

  async start(): Promise<StartedFlagServer> {
    if (this.server) throw new Error("Flag server is already started");
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { error: "internal_error" });
        else res.destroy();
      });
    });
    this.server.requestTimeout = 10_000;
    this.server.headersTimeout = 15_000;
    const heartbeatMs = this.options.heartbeatMs ?? 15_000;
    this.heartbeat = setInterval(() => {
      for (const clients of this.clients.values()) {
        for (const client of clients) if (!client.write(": heartbeat\n\n")) client.destroy();
      }
    }, heartbeatMs);
    this.heartbeat.unref?.();

    const host = this.options.host ?? "127.0.0.1";
    const port = this.options.port ?? 0;
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once("error", reject);
        this.server?.listen(port, host, () => {
          this.server?.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      clearInterval(this.heartbeat);
      this.server = undefined;
      throw error;
    }
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Flag server did not bind to a TCP port");
    return { host, port: address.port, url: `http://${host}:${address.port}` };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    clearInterval(this.heartbeat);
    for (const clients of this.clients.values()) for (const client of clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

export function createFlagServer(options: FlagServerOptions): FlagServer {
  return new FlagServer(options);
}
