/**
 * Multi-account credential pool for dsh-workbuddy-connect.
 *
 * The upstream plugin ships ONE credential store per variant (the desktop App's
 * file plus the plugin's own refreshed copy). This module layers an account
 * pool on top of it so that when an account runs out of credit the next account
 * is used instead of failing the turn.
 *
 * Design constraints, all learned from the Hermes supervisor that solved the
 * same problem (see `hermes/plugins/model-providers/workbuddy/supervisor.py`):
 *
 * 1. **Never switch after bytes were written.** A chat stream that already
 *    started cannot be replayed on another account without the client seeing
 *    two concatenated answers. The pool only hands out a *suggested next*
 *    account, and the shim only retries before it writes its response head.
 * 2. **Not every failure is an account failure.** `hard_credit` (402 / quota
 *    exhausted) is sticky for the rest of the round and cools the account for a
 *    long time. `session_dead` (401) does not cool (a cooldown cannot restore a
 *    dead session) but is skipped in this round. `soft_rate` (429 / saturated
 *    model) is transient and cools briefly.
 * 3. **An account file is a credential.** Files live under DSH home, are
 *    read-only to this module except for refreshed tokens, and tokens never
 *    leave the process.
 * 4. **Zero-account behaviour must not change.** When the account directory is
 *    missing or empty the pool is inert and the original single-account path
 *    runs exactly as before.
 *
 * Account file format (what `login_account.py` in the Hermes plugin writes):
 *   { "auth": { "accessToken", "refreshToken", "expiresAt", "refreshExpiresAt",
 *               "domain", ... },
 *     "account": { "uid", "nickname", "enterpriseId"? } }
 * Both seconds and milliseconds are accepted for the expiry fields.
 *
 * @module dsh-workbuddy-connect/multi-account
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Long cooldown after a hard quota failure; credit does not come back in seconds. */
const COOLDOWN_HARD_CREDIT_MS = 60 * 60 * 1000;
/** Short cooldown for a transient rate limit / saturated model. */
const COOLDOWN_RATE_LIMIT_MS = 60 * 1000;
/** Short cooldown for an account whose session is dead (skipped but not trusted). */
const COOLDOWN_SESSION_DEAD_MS = 10 * 60 * 1000;
/** Cooldown for an unclassified upstream failure. */
const COOLDOWN_UNKNOWN_MS = 20 * 1000;

/** Upstream failure classes this pool reacts to; mirrors the shim's kinds. */
export const ACCOUNT_FAILURES = new Set(["hard_credit", "soft_rate", "session_dead"]);

/** Normalise an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
  if (typeof value !== "number" || value <= 0) return 0;
  return value > 1e11 ? value : value * 1000;
}

/**
 * Resolve an absolute expiry from either an absolute field (`expiresAt`) or a
 * relative lifetime (`expiresIn`, seconds remaining) plus the file's mtime.
 *
 * Hermes' login helper writes only `expiresIn`/`refreshExpiresIn`, so a reader
 * that understands only `expiresAt` reads every pooled account as "no expiry"
 * and refreshes on the first request — spending the refresh token needlessly.
 * The mtime is the only stable reference for when the lifetime was measured.
 */
function resolveExpiry(auth, mtimeMs) {
  const absolute = expiryToMs(auth.expiresAt);
  if (absolute > 0) return absolute;
  const lifetime = typeof auth.expiresIn === "number" && auth.expiresIn > 0 ? auth.expiresIn : 0;
  if (lifetime === 0) return 0;
  const base = typeof mtimeMs === "number" && mtimeMs > 0 ? mtimeMs : Date.now();
  return base + lifetime * 1000;
}

function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parse one account file into the pool's credential shape.
 *
 * Accepts both the nested `{auth, account}` form written by the Hermes login
 * helper and the flat panel form. Rejects a file without an access token rather
 * than surfacing an account that can never answer.
 */
export function parseAccountDocument(text, mtimeMs) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const auth = typeof parsed.auth === "object" && parsed.auth !== null ? parsed.auth : parsed;
  const identity = typeof parsed.account === "object" && parsed.account !== null ? parsed.account : parsed;
  const accessToken = optionalString(auth.accessToken);
  if (accessToken === undefined) return undefined;
  const enterpriseId = optionalString(identity.enterpriseId);
  const nickname = optionalString(identity.nickname);
  const refreshExpiresAtMs = expiryToMs(auth.refreshExpiresAt) || resolveFromLifetime(auth.refreshExpiresIn, mtimeMs);
  return {
    accessToken,
    refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
    expiresAtMs: resolveExpiry(auth, mtimeMs),
    ...(refreshExpiresAtMs === 0 ? {} : { refreshExpiresAtMs }),
    domain: optionalString(auth.domain) ?? "",
    uid: optionalString(identity.uid) ?? "",
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    ...(nickname === undefined ? {} : { nickname }),
    source: "pool",
  };
}

/** Absolute expiry from a remaining-lifetime field, anchored at the file mtime. */
function resolveFromLifetime(seconds, mtimeMs) {
  if (typeof seconds !== "number" || seconds <= 0) return 0;
  const base = typeof mtimeMs === "number" && mtimeMs > 0 ? mtimeMs : Date.now();
  return base + seconds * 1000;
}

/** A stable short label for one account, used in logs and the status card. */
export function accountLabel(credential, index) {
  const uid = credential.uid !== "" ? credential.uid.slice(0, 8) : "unknown";
  const nick = credential.nickname ?? "";
  return nick !== "" ? `${nick} (${uid})` : `#${index + 1} ${uid}`;
}

/**
 * The account pool.
 *
 * Reads every `*.json` in the directory once per `load()`, keeps the in-memory
 * credential objects current as tokens are refreshed, and records per-account
 * cooldowns and failure tallies so the next request can pick sensibly.
 */
export class WorkBuddyAccountPool {
  /**
   * @param {object} options
   * @param {string} options.dir - directory holding one JSON file per account.
   * @param {(credential: object) => Promise<object>} options.refresh - the
   *   upstream token refresher (same one the single-account store injects).
   * @param {string} [options.region] - "cn" | "global"; files whose domain
   *   resolves to the other region are skipped so a CN pool never sends an
   *   international credential upstream.
   * @param {(ms: number) => void} [options.now] - injectable clock for tests.
   */
  constructor(options) {
    this.dir = options.dir;
    this.refresh = options.refresh;
    this.region = options.region;
    this.now = options.now ?? (() => Date.now());
    /** @type {Map<string, {file: string, credential: object, cooldownUntil: number, failures: number, lastError?: string}>} */
    this.accounts = new Map();
    /** Whether a load has completed at least once. */
    this.loaded = false;
    /** File of the account that served the most recent request, for the panel. */
    this.activeFile = undefined;
    /** How long a fetched credit balance stays usable, in ms. */
    this.creditsTtlMs = options.creditsTtlMs ?? 5 * 60 * 1000;
    /** In-flight balance reads, so concurrent callers share one request. */
    this.creditsInflight = new Map();
    /** Why the last load produced no usable accounts, for the status card. */
    this.loadError = undefined;
    /** Credentials that are currently inside the refresh margin. */
    this.refreshMarginMs = 5 * 60 * 1000;
    this.inflightRefresh = new Map();
  }

  /** Whether the pool holds at least one account. */
  get size() {
    return this.accounts.size;
  }

  /**
   * Re-read the account directory. Files that vanish are dropped; files whose
   * content changed (a re-login) replace the cached credential. A directory
   * that does not exist yields an empty pool and no error — the plugin then
   * falls back to its original single-account behaviour.
   */
  async load() {
    let names;
    try {
      names = (await readdir(this.dir)).filter((name) => name.endsWith(".json")).sort();
    } catch (error) {
      this.accounts.clear();
      this.loadError = error?.code === "ENOENT" ? undefined : String(error?.message ?? error);
      this.loaded = true;
      return this;
    }
    const seen = new Set();
    for (const file of names) {
      const path = join(this.dir, file);
      let text;
      let mtimeMs;
      try {
        const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        text = content;
        mtimeMs = info.mtimeMs;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        this.loadError = String(error?.message ?? error);
        continue;
      }
      const credential = parseAccountDocument(text, mtimeMs);
      if (credential === undefined) continue;
      if (this.region !== undefined && regionOfDomain(credential.domain) !== this.region) continue;
      seen.add(file);
      const existing = this.accounts.get(file);
      const signature = signatureOf(credential);
      // Keep live state (cooldowns, tallies) when the file did not change; a
      // re-login invalidates the old session, so its cooldown must go too.
      if (existing !== undefined && existing.signature === signature) continue;
      this.accounts.set(file, {
        file,
        credential,
        signature,
        cooldownUntil: 0,
        failures: 0,
        lastError: undefined,
        credits: undefined,
        creditsAtMs: 0,
      });
    }
    for (const file of [...this.accounts.keys()]) {
      if (!seen.has(file)) this.accounts.delete(file);
    }
    this.loadError = undefined;
    this.loaded = true;
    return this;
  }

  /** Whether the pool has anything to serve at all. */
  available() {
    return this.accounts.size > 0;
  }

  /** Accounts currently past their cooldown, in file order. */
  healthy() {
    const now = this.now();
    return [...this.accounts.values()].filter((entry) => entry.cooldownUntil <= now);
  }

  /**
   * The account to try first for a new request.
   *
   * Preference order: a healthy account with no failures first, then the least
   * recently failing one. Round-robin across equals keeps two accounts from
   * seeing wildly asymmetric traffic.
   */
  pick(preferredFile) {
    const entries = [...this.accounts.values()];
    if (entries.length === 0) return undefined;
    const now = this.now();
    if (preferredFile !== undefined) {
      const preferred = this.accounts.get(preferredFile);
      if (preferred !== undefined && preferred.cooldownUntil <= now) return preferred;
    }
    // A manual switch outranks the health ordering while the pinned account is
    // usable; a pinned account that is cooling is dropped, so a switch never
    // replays the failure the cooldown exists to avoid.
    if (this.manualPin !== undefined) {
      const pinned = this.accounts.get(this.manualPin);
      if (pinned !== undefined && pinned.cooldownUntil <= now) return pinned;
      this.manualPin = undefined;
    }
    const healthy = entries.filter((entry) => entry.cooldownUntil <= now);
    const candidates = healthy.length > 0 ? healthy : entries;
    return candidates.reduce((best, entry) => {
      if (best === undefined) return entry;
      if (entry.failures !== best.failures) return entry.failures < best.failures ? entry : best;
      return entry.lastUsedAt < best.lastUsedAt ? entry : best;
    }, undefined);
  }

  /**
   * The next account to try after `failedFile` failed with `kind`.
   *
   * Records the failure and cooldown first, so the caller can rely on the
   * returned account already being the freshest healthy choice. Returns
   * undefined when every account is cooling down.
   */
  next(failedFile, kind) {
    this.note(failedFile, kind);
    const entries = [...this.accounts.values()];
    const now = this.now();
    return entries
      .filter((entry) => entry.file !== failedFile && entry.cooldownUntil <= now)
      .reduce((best, entry) => {
        if (best === undefined) return entry;
        return entry.failures < best.failures ? entry : best;
      }, undefined);
  }

  /**
   * Point the pool at one account: the next request starts there.
   *
   * Refuses a file the pool does not hold and one that is cooling down, because
   * "switch to a cooling account" would only replay the failure the cooldown
   * exists to avoid. Returns the entry it switched to, or undefined.
   */
  switchTo(file) {
    const entry = this.accounts.get(file);
    if (entry === undefined) return undefined;
    if (entry.cooldownUntil > this.now()) return undefined;
    this.activeFile = file;
    this.manualPin = file;
    return entry;
  }

  /** The account the next request will start from, if a choice has been made. */
  currentFile() {
    return this.activeFile;
  }

  /** Record a successful use. */
  succeeded(file) {
    const entry = this.accounts.get(file);
    if (entry === undefined) return;
    // A manual choice only outlives automatic use when it is still usable;
    // otherwise the pin follows the account that actually served the request.
    if (this.manualPin !== undefined && this.accounts.get(this.manualPin)?.cooldownUntil > this.now()) this.manualPin = undefined;
    entry.failures = 0;
    entry.cooldownUntil = 0;
    entry.lastError = undefined;
    entry.lastUsedAt = this.now();
    this.activeFile = file;
  }

  /** Record a failure against one account and apply its cooldown. */
  note(file, kind) {
    const entry = this.accounts.get(file);
    if (entry === undefined) return;
    const now = this.now();
    entry.failures += 1;
    entry.lastError = kind;
    entry.lastUsedAt = now;
    entry.cooldownUntil = now + cooldownFor(kind);
  }

  /**
   * A credential that is safe to send upstream: refreshed when inside the
   * margin, never written back to the account file (the file belongs to the
   * Hermes login helper; silently rewriting it would desynchronise the two).
   * Refreshed tokens live in memory for the process lifetime.
   */
  async resolve(file) {
    const entry = this.accounts.get(file);
    if (entry === undefined) throw new Error(`workbuddy pool: unknown account ${file}`);
    const credential = entry.credential;
    if (!needsRefresh(credential, this.now(), this.refreshMarginMs)) return credential;
    const inflight = this.inflightRefresh.get(file);
    if (inflight !== undefined) return inflight;
    const task = this.refreshNow(file, credential).finally(() => {
      this.inflightRefresh.delete(file);
    });
    this.inflightRefresh.set(file, task);
    return task;
  }

  async refreshNow(file, credential) {
    const entry = this.accounts.get(file);
    if (entry === undefined || credential.refreshToken === "") return credential;
    try {
      const outcome = await this.refresh(credential);
      const refreshed = {
        ...credential,
        accessToken: outcome.accessToken,
        ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
        expiresAtMs:
          outcome.expiresInSec !== undefined
            ? this.now() + outcome.expiresInSec * 1000
            : credential.expiresAtMs,
        source: "pool-refreshed",
      };
      if (entry !== undefined) {
        entry.credential = refreshed;
        entry.signature = signatureOf(refreshed);
      }
      return refreshed;
    } catch (error) {
      // A failed refresh must not take down an account whose token is still
      // valid: the single-account store applies the same rule.
      if (credential.expiresAtMs > this.now() + 30_000) return credential;
      this.note(file, "session_dead");
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * The credit balance for one pooled account.
   *
   * Cached for `creditsTtlMs`; a failure is cached too (shorter) so a broken
   * account does not hammer the billing endpoint on every poll. Concurrent
   * callers share one in-flight request.
   */
  async creditsFor(file, fetcher) {
    const entry = this.accounts.get(file);
    if (entry === undefined) return undefined;
    if (fetcher === undefined) return entry.credits;
    const now = this.now();
    if (entry.credits !== undefined && now - entry.creditsAtMs < this.creditsTtlMs) return entry.credits;
    const inflight = this.creditsInflight.get(file);
    if (inflight !== undefined) return inflight;
    const task = (async () => {
      try {
        const credential = await this.resolve(file);
        const balance = await fetcher(credential);
        const total = typeof balance?.total === "number" ? balance.total : undefined;
        entry.credits = {
          ...(total === undefined ? {} : { total }),
          ...Array.isArray(balance?.accounts) ? { packages: balance.accounts.length } : {},
          fetchedAtMs: now,
        };
        entry.creditsAtMs = now;
      } catch (error) {
        entry.credits = { error: String(error?.message ?? error), fetchedAtMs: now };
        entry.creditsAtMs = now;
      } finally {
        this.creditsInflight.delete(file);
      }
      return entry.credits;
    })();
    this.creditsInflight.set(file, task);
    return task;
  }

  /** Refresh every account's balance, sequentially to stay gentle on the upstream. */
  async refreshAllCredits(fetcher) {
    for (const file of this.accounts.keys()) {
      await this.creditsFor(file, fetcher);
    }
    return this.describe();
  }

  /** A read-only view for the settings card and `doctor`. */
  describe() {
    const now = this.now();
    return {
      dir: this.dir,
      total: this.accounts.size,
      usable: this.healthy().length,
      accounts: [...this.accounts.values()].map((entry, index) => ({
        file: entry.file,
        label: accountLabel(entry.credential, index),
        uid: entry.credential.uid,
        domain: entry.credential.domain,
        expiresAtMs: entry.credential.expiresAtMs,
        coolingDownSeconds: Math.max(0, Math.round((entry.cooldownUntil - now) / 1000)),
        failures: entry.failures,
        lastError: entry.lastError,
        ...(entry.credits === undefined ? {} : { credits: entry.credits }),
      })),
    };
  }
}

function cooldownFor(kind) {
  switch (kind) {
    case "hard_credit":
      return COOLDOWN_HARD_CREDIT_MS;
    case "soft_rate":
      return COOLDOWN_RATE_LIMIT_MS;
    case "session_dead":
      return COOLDOWN_SESSION_DEAD_MS;
    default:
      return COOLDOWN_UNKNOWN_MS;
  }
}

function needsRefresh(credential, now, marginMs) {
  if (credential.expiresAtMs <= 0) return true;
  return now + marginMs >= credential.expiresAtMs;
}

function regionOfDomain(domain) {
  const lowered = String(domain ?? "").trim().toLowerCase();
  return lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai") ? "global" : "cn";
}

function signatureOf(credential) {
  return createHash("sha256")
    .update(
      JSON.stringify([credential.accessToken, credential.refreshToken, credential.uid, credential.expiresAtMs]),
    )
    .digest("hex")
    .slice(0, 16);
}

/** Ensure a directory exists (called by the CLI import command). */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

/** Write one account file atomically enough for a helper script. */
export async function writeAccountFile(path, document) {
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
}
