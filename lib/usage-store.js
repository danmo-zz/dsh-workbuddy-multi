/**
 * Token accounting for WorkBuddy requests.
 *
 * The upstream SSE stream carries a full `usage` object on its final event
 * (`prompt_tokens`, `completion_tokens`, `total_tokens`, cache and reasoning
 * breakdowns, and `credit` for the credits a call consumed). The shim sees
 * every chunk on its way to the client, so this module tails the stream, picks
 * the last usage object per response, and adds it to per-account totals.
 *
 * Persisted at `<DSH home>/.workbuddy-usage.json` so totals survive restarts.
 * The file holds counters only — no prompts, no responses, no token material.
 *
 * @module dsh-workbuddy-connect/usage
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FORMAT_VERSION = 1;
const SAVE_DEBOUNCE_MS = 2000;

/** A finite non-negative number, else 0. */
function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Reduce one upstream `usage` object to the counters we report.
 *
 * Upstream nests cache and reasoning figures in `*_details`, and older shapes
 * put them at the top level; both spellings are accepted, and a zero total is
 * treated as "no usage" so an empty event cannot inflate the request count.
 */
function pickUsage(raw) {
  if (typeof raw !== "object" || raw === null) return undefined;
  const prompt = num(raw.prompt_tokens);
  const completion = num(raw.completion_tokens);
  const total = num(raw.total_tokens) || prompt + completion;
  if (total === 0) return undefined;

  const promptDetails = typeof raw.prompt_tokens_details === "object" && raw.prompt_tokens_details !== null ? raw.prompt_tokens_details : {};
  const completionDetails =
    typeof raw.completion_tokens_details === "object" && raw.completion_tokens_details !== null ? raw.completion_tokens_details : {};

  const cacheHit = num(raw.prompt_cache_hit_tokens) || num(promptDetails.cached_tokens) || num(raw.cached_tokens);
  const reasoning = num(completionDetails.reasoning_tokens) || num(raw.completion_thinking_tokens);
  const credit = num(raw.credit);

  return {
    prompt,
    completion,
    total,
    ...(cacheHit > 0 ? { cacheHit } : {}),
    ...(reasoning > 0 ? { reasoning } : {}),
    ...(credit > 0 ? { credit } : {}),
  };
}

/**
 * Extract the last usage object from a block of complete SSE lines.
 *
 * A chunk may carry several `data:` lines; the caller feeds complete lines and
 * keeps any trailing partial for the next chunk.
 */
export function usageFromLines(text) {
  let found;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event && typeof event === "object" && event.usage) {
        const picked = pickUsage(event.usage);
        if (picked !== undefined) found = picked;
      }
    } catch {
      /* keepalive or non-JSON */
    }
  }
  return found;
}

/** Default store path beside the plugin's other state under the Harness home. */
export function defaultUsagePath(dshHome) {
  return join(dshHome, ".workbuddy-usage.json");
}

const EMPTY_BUCKET = { prompt: 0, completion: 0, total: 0, cacheHit: 0, reasoning: 0, credit: 0, requests: 0 };

export class WorkBuddyUsageStore {
  constructor(options = {}) {
    this.path = options.path ?? defaultUsagePath(options.dshHome ?? ".");
    this.now = options.now ?? (() => Date.now());
    this.accounts = {};
    this.totals = { ...EMPTY_BUCKET };
    this.since = this.now();
    this.loaded = false;
    this.dirty = false;
    this.timer = undefined;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      if (!existsSync(this.path)) return this;
      const document = JSON.parse(readFileSync(this.path, "utf8"));
      if (document?.version !== FORMAT_VERSION) return this;
      if (typeof document.accounts === "object" && document.accounts !== null) this.accounts = document.accounts;
      if (typeof document.totals === "object" && document.totals !== null) this.totals = { ...EMPTY_BUCKET, ...document.totals };
      if (typeof document.since === "number") this.since = document.since;
    } catch {
      /* a corrupt file reads as "no history" rather than blocking the plugin */
    }
    return this;
  }

  /** Add one response's usage to an account and to the running totals. */
  record(accountFile, usage) {
    if (usage === undefined) return;
    this.load();
    const key = accountFile ?? "(unknown)";
    const bucket = { ...EMPTY_BUCKET, ...(this.accounts[key] ?? {}) };
    const add = (field, value) => {
      if (value === undefined || value === 0) return;
      bucket[field] = num(bucket[field]) + value;
      this.totals[field] = num(this.totals[field]) + value;
    };
    add("prompt", usage.prompt);
    add("completion", usage.completion);
    add("total", usage.total);
    add("cacheHit", usage.cacheHit);
    add("reasoning", usage.reasoning);
    add("credit", usage.credit);
    bucket.requests = num(bucket.requests) + 1;
    this.totals.requests = num(this.totals.requests) + 1;
    this.accounts[key] = bucket;
    this.scheduleSave();
  }

  scheduleSave() {
    this.dirty = true;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Write immediately; used on shutdown and by the tests. */
  saveNow() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const document = {
        version: FORMAT_VERSION,
        since: this.since,
        totals: this.totals,
        accounts: this.accounts,
      };
      const temporary = `${this.path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch {
      /* accounting must never break a chat request */
    }
  }

  /** The read-only view the panel renders. */
  describe() {
    this.load();
    return {
      since: this.since,
      totals: { ...this.totals },
      accounts: Object.entries(this.accounts).map(([file, bucket]) => ({ file, ...bucket })),
    };
  }
}
