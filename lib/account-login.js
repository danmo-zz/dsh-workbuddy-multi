/**
 * Browser sign-in for adding accounts.
 *
 * Reimplements the VSCode-extension sign-in flow the WorkBuddy desktop client
 * uses, so an account can be added without the desktop App:
 *
 *   1. POST /v2/plugin/auth/state?platform=VSCode  -> { state, authUrl }
 *   2. the user opens authUrl and signs in in any browser
 *   3. GET  /v2/plugin/auth/token?state=...        -> token (11217 while pending)
 *   4. GET  /v2/plugin/login/account?state=...     -> { uid, nickname, ... }
 *   5. both are written to a pool account file
 *
 * `platform=VSCode` matters: it issues the credential generation the CLI/plugin
 * protocol expects, which is why a token obtained this way is usable by the
 * chat endpoints while a website-session token is not.
 *
 * Sessions are single-use and short-lived. Each holds only the state string and
 * the timestamp; nothing is written to disk until the sign-in completes.
 *
 * @module dsh-workbuddy-connect/account-login
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Endpoints per region. */
export const LOGIN_ENDPOINTS = {
  global: "https://www.workbuddy.ai",
  cn: "https://www.workbuddy.cn",
};

/** How long a pending sign-in stays pollable. */
const SESSION_TTL_MS = 10 * 60 * 1000;
/** Upstream codes that mean "not signed in yet". */
const PENDING_CODES = new Set([11217]);

/** Headers the plugin-auth endpoints expect. */
function authHeaders() {
  return {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; Genie-IDE/1.0)",
    "X-Product-Code": "codebuddy",
    "X-No-Authorization": "true",
    "X-No-User-Id": "true",
    "X-No-Enterprise-Id": "true",
    "X-No-Department-Info": "true",
  };
}

/** Unwrap the `{data: {...}}` envelope these endpoints use. */
function unwrap(body) {
  if (body && typeof body === "object") {
    if (body.data && typeof body.data === "object") return body;
    return body;
  }
  return body;
}

/** A token is only usable if it carries an access token. */
function isToken(value) {
  return typeof value === "object" && value !== null && typeof value.accessToken === "string" && value.accessToken !== "";
}

/** A sign-in is complete only once the account identity resolves. */
function isAccount(value) {
  return typeof value === "object" && value !== null && typeof value.uid === "string" && value.uid !== "";
}

/**
 * Pending sign-ins, keyed by a local id the browser half refers to.
 *
 * Held in memory only: a restart drops them, which is correct because the
 * upstream state is single-use and the user cannot have completed a sign-in
 * against a session this process no longer knows about.
 */
export class WorkBuddyLoginSessions {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.sessions = new Map();
    this.sequence = 0;
  }

  /** Drop expired sessions so the map cannot grow without bound. */
  prune() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) this.sessions.delete(id);
    }
  }

  /**
   * Start a sign-in and return the URL to open.
   *
   * @returns {{ id: string, authUrl: string, region: string }}
   */
  async begin(region) {
    this.prune();
    const endpoint = LOGIN_ENDPOINTS[region];
    if (endpoint === undefined) throw new Error(`unknown region: ${region}`);

    const response = await this.fetch(`${endpoint}/v2/plugin/auth/state?platform=VSCode`, {
      method: "POST",
      headers: authHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body = unwrap(await response.json().catch(() => undefined));
    const data = body?.data ?? body;
    const state = typeof data?.state === "string" ? data.state : "";
    const authUrl = typeof data?.authUrl === "string" ? data.authUrl : "";
    if (!response.ok || state === "" || authUrl === "") {
      throw new Error(`could not request a sign-in link (HTTP ${response.status})`);
    }

    this.sequence += 1;
    const id = `login-${this.now().toString(36)}-${this.sequence}`;
    this.sessions.set(id, { id, state, authUrl, region, createdAt: this.now() });
    return { id, authUrl, region };
  }

  /**
   * Poll one pending sign-in.
   *
   * @returns one of
   *   { status: "pending" }
   *   { status: "expired" }            unknown or timed-out session
   *   { status: "done", credential }   fully signed in
   *   { status: "error", message }
   */
  async poll(id) {
    this.prune();
    const session = this.sessions.get(id);
    if (session === undefined) return { status: "expired" };

    const endpoint = LOGIN_ENDPOINTS[session.region];
    const stateQuery = `state=${encodeURIComponent(session.state)}`;

    let tokenBody;
    try {
      const response = await this.fetch(`${endpoint}/v2/plugin/auth/token?${stateQuery}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      tokenBody = await response.json().catch(() => undefined);
    } catch (error) {
      return { status: "error", message: String(error?.message ?? error) };
    }

    const code = tokenBody?.code;
    if (PENDING_CODES.has(code)) return { status: "pending" };
    const token = unwrap(tokenBody)?.data ?? unwrap(tokenBody);
    if (!isToken(token)) {
      // Anything else (expired state, rejected sign-in) ends the session.
      const message = typeof tokenBody?.msg === "string" ? tokenBody.msg : `code ${code ?? "?"}`;
      this.sessions.delete(id);
      return { status: "error", message };
    }

    let account;
    try {
      const response = await this.fetch(`${endpoint}/v2/plugin/login/account?${stateQuery}`, {
        headers: {
          ...authHeaders(),
          Authorization: `Bearer ${token.accessToken}`,
          ...(typeof token.domain === "string" && token.domain !== "" ? { "X-Domain": token.domain } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = unwrap(await response.json().catch(() => undefined));
      account = body?.data ?? body;
    } catch (error) {
      return { status: "error", message: String(error?.message ?? error) };
    }

    if (!isAccount(account)) {
      // The token exists but the identity is not ready yet.
      return { status: "pending" };
    }

    this.sessions.delete(id);
    return {
      status: "done",
      credential: {
        accessToken: token.accessToken,
        refreshToken: typeof token.refreshToken === "string" ? token.refreshToken : "",
        expiresAtMs: typeof token.expiresAt === "number" ? token.expiresAt : this.now() + (Number(token.expiresIn) || 0) * 1000,
        ...(typeof token.refreshExpiresAt === "number" ? { refreshExpiresAtMs: token.refreshExpiresAt } : {}),
        domain: typeof token.domain === "string" && token.domain !== "" ? token.domain : session.region === "global" ? "www.workbuddy.ai" : "www.workbuddy.cn",
        uid: account.uid,
        ...(typeof account.nickname === "string" ? { nickname: account.nickname } : {}),
        ...(typeof account.enterpriseId === "string" && account.enterpriseId !== "" ? { enterpriseId: account.enterpriseId } : {}),
        source: "login",
      },
    };
  }

  /** Forget a session (the user cancelled). */
  cancel(id) {
    this.sessions.delete(id);
    return true;
  }
}

/**
 * Write one signed-in credential to the pool directory.
 *
 * The file is the same shape the desktop App and the Hermes helper produce, so
 * the pool reads it with no special case. An existing file for the same uid is
 * replaced in place, which is how re-signing in refreshes an account rather
 * than adding a duplicate.
 */
export async function savePoolAccount(dir, credential) {
  await mkdir(dir, { recursive: true });
  const slug = credential.uid.replace(/[^A-Za-z0-9-]/gu, "").slice(0, 8) || "account";
  const target = join(dir, `${slug}.json`);
  const document = {
    auth: {
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAtMs,
      ...(credential.refreshExpiresAtMs === undefined ? {} : { refreshExpiresAt: credential.refreshExpiresAtMs }),
      domain: credential.domain,
    },
    account: {
      uid: credential.uid,
      ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
      ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
    },
  };
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return { path: target, file: `${slug}.json` };
}
