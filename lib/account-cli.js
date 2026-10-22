#!/usr/bin/env node
/**
 * Account pool CLI for the multi-account WorkBuddy plugin.
 *
 *   node lib/account-cli.js status          show pooled accounts and cooldowns
 *   node lib/account-cli.js check           verify each account against the catalog endpoint
 *   node lib/account-cli.js import <src>    copy Hermes account files into the DSH pool
 *   node lib/account-cli.js path            print the pool directory
 *
 * The pool directory is `$WORKBUDDY_ACCOUNTS_DIR` or `<DSH home>/workbuddy-accounts`.
 * Tokens are never printed; only uid prefixes and statuses are.
 */
import { copyFile, mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { WorkBuddyAccountPool } from "./multi-account.js";

const APP_UA = "WorkBuddyAI/5.8.4";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CN_BASE = "https://copilot.tencent.com";

function poolDir() {
  if (process.env.WORKBUDDY_ACCOUNTS_DIR) return process.env.WORKBUDDY_ACCOUNTS_DIR;
  const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(dshHome, "workbuddy-accounts");
}

function regionBase(domain) {
  return String(domain ?? "").toLowerCase().includes("workbuddy.ai") ? GLOBAL_BASE : CN_BASE;
}

/** One catalog read per account; only reads, never spends credit. */
async function probeAccount(credential) {
  const base = regionBase(credential.domain);
  try {
    const response = await fetch(`${base}/v3/config`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        Origin: base,
        Referer: `${base}/`,
        ...(credential.domain === "" ? {} : { "X-Domain": credential.domain }),
        "User-Agent": APP_UA,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (response.ok) {
      let models = 0;
      try {
        models = (text.match(/"id"\s*:/g) ?? []).length;
      } catch {
        /* count stays 0 */
      }
      return { ok: true, status: response.status, models };
    }
    let message = text.slice(0, 120);
    try {
      message = JSON.parse(text).msg ?? message;
    } catch {
      /* keep the slice */
    }
    return { ok: false, status: response.status, message };
  } catch (error) {
    return { ok: false, status: 0, message: String(error?.message ?? error) };
  }
}

async function loadPool(region) {
  const pool = new WorkBuddyAccountPool({ dir: poolDir(), region, refresh: async () => ({ accessToken: "" }) });
  await pool.load();
  return pool;
}

async function cmdStatus(region) {
  const pool = await loadPool(region);
  const view = pool.describe();
  console.log(`pool directory: ${view.dir}`);
  if (view.total === 0) {
    console.log(`no accounts${pool.loadError === undefined ? " (directory empty or absent)" : ` — ${pool.loadError}`}`);
    return 0;
  }
  console.log(`accounts: ${view.total}, usable now: ${view.usable}`);
  for (const account of view.accounts) {
    const expiry = account.expiresAtMs > 0 ? new Date(account.expiresAtMs).toISOString().slice(0, 16).replace("T", " ") : "unknown";
    const cool = account.coolingDownSeconds > 0 ? ` cooling ${account.coolingDownSeconds}s (${account.lastError})` : "";
    console.log(`  - ${account.file}  uid=${account.uid.slice(0, 8)}  expires=${expiry}${cool}`);
  }
  return 0;
}

async function cmdCheck(region) {
  const pool = await loadPool(region);
  if (pool.size === 0) {
    console.log("no accounts to check");
    return 1;
  }
  let bad = 0;
  for (const account of pool.describe().accounts) {
    const credential = pool.accounts.get(account.file).credential;
    const result = await probeAccount(credential);
    if (result.ok) console.log(`OK    ${account.file}  uid=${account.uid.slice(0, 8)}  models=${result.models}`);
    else {
      bad += 1;
      console.log(`FAIL  ${account.file}  uid=${account.uid.slice(0, 8)}  http=${result.status}  ${result.message}`);
    }
  }
  return bad === 0 ? 0 : 1;
}

/**
 * Copy account files in. Duplicate uids are skipped so importing the same
 * account twice cannot create two entries that both drain one quota.
 */
async function cmdImport(source, region) {
  const dir = poolDir();
  await mkdir(dir, { recursive: true });
  const existing = new WorkBuddyAccountPool({ dir, region, refresh: async () => ({ accessToken: "" }) });
  await existing.load();
  const known = new Set([...existing.accounts.values()].map((entry) => entry.credential.uid));
  const names = (await readdir(source)).filter((name) => name.endsWith(".json")).sort();
  let imported = 0;
  let skipped = 0;
  for (const name of names) {
    const target = join(dir, basename(name));
    const probe = new WorkBuddyAccountPool({ dir: source, region, refresh: async () => ({ accessToken: "" }) });
    await probe.load();
    const entry = probe.accounts.get(name);
    if (entry === undefined) {
      console.log(`skip ${name}: not a usable credential for region ${region}`);
      skipped += 1;
      continue;
    }
    if (known.has(entry.credential.uid)) {
      console.log(`skip ${name}: uid ${entry.credential.uid.slice(0, 8)} already pooled`);
      skipped += 1;
      continue;
    }
    await copyFile(join(source, name), target);
    known.add(entry.credential.uid);
    imported += 1;
    console.log(`imported ${name} -> ${target} (uid ${entry.credential.uid.slice(0, 8)})`);
  }
  console.log(`\n${imported} imported, ${skipped} skipped into ${dir}`);
  return imported > 0 ? 0 : 1;
}

const [, , command = "status", ...rest] = process.argv;
const regionFlag = rest.indexOf("--region");
const region = regionFlag >= 0 ? rest[regionFlag + 1] : "global";

switch (command) {
  case "status":
    process.exitCode = await cmdStatus(region);
    break;
  case "check":
    process.exitCode = await cmdCheck(region);
    break;
  case "import":
    if (rest[0] === undefined) {
      console.error("usage: account-cli.js import <source-dir> [--region cn|global]");
      process.exitCode = 2;
      break;
    }
    process.exitCode = await cmdImport(rest[0], region);
    break;
  case "path":
    console.log(poolDir());
    break;
  default:
    console.error(`unknown command: ${command}`);
    process.exitCode = 2;
}
