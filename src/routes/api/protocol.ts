import { BridgeClient, BridgeError } from "../../protocol/bridgeClient";
import {
  deleteProtocolAccount,
  getProtocolAccount,
  insertProtocolAccount,
  listProtocolAccounts,
  listTasksByProtocolAccount,
  updateProtocolAccountStatus,
} from "../../db/queries";
import type { BridgeConfigResponse, ProtocolAccountSummary } from "../../shared/rpcTypes";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function bridgeErr(e: unknown) {
  if (e instanceof BridgeError) {
    return { ok: false, errorCode: 0, description: e.message, reason: e.reason, retryAfter: e.retryAfter };
  }
  return { ok: false, errorCode: 0, description: e instanceof Error ? e.message : String(e), reason: "unknown" as const };
}

// Bridge config — stored in app_settings. GET never returns the secret.

export async function handleGetBridgeConfig(env: Env): Promise<Response> {
  const row = await env.DB.prepare(`SELECT value FROM app_settings WHERE key = 'bridge_url'`)
    .first<{ value: string }>();
  const url = row?.value ?? null;
  const data: BridgeConfigResponse = { url, configured: !!url };
  return json({ ok: true, data });
}

export async function handleSetBridgeConfig(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { url?: string; secret?: string };
  const url = (body.url ?? "").trim().replace(/\/+$/, "");
  const secret = (body.secret ?? "").trim();
  if (!url) {
    return json({ ok: false, errorCode: 0, description: "url is required", reason: "invalid_request" }, 400);
  }
  try {
    new URL(url);
  } catch {
    return json({ ok: false, errorCode: 0, description: "url is not a valid URL", reason: "invalid_request" }, 400);
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bridge_url', ?)`).bind(url),
    ...(secret
      ? [env.DB.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bridge_secret', ?)`).bind(secret)]
      : []),
  ]);
  return json({ ok: true, data: { url, configured: true } });
}

// Protocol accounts

export async function handleListProtocolAccounts(env: Env): Promise<Response> {
  const accounts = await listProtocolAccounts(env.DB);
  return json({ ok: true, data: accounts });
}

export async function handleCreateProtocolAccount(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { label?: string; phone?: string };
  const phone = (body.phone ?? "").trim();
  const label = (body.label ?? "").trim() || phone;
  if (!phone) {
    return json({ ok: false, errorCode: 0, description: "phone is required", reason: "invalid_request" }, 400);
  }
  const account: ProtocolAccountSummary = {
    id: crypto.randomUUID(),
    label,
    phone,
    status: "unknown",
    created_at: Math.floor(Date.now() / 1000),
  };
  await insertProtocolAccount(env.DB, account);
  return json({ ok: true, data: account }, 201);
}

export async function handleGetProtocolAccount(env: Env, id: string): Promise<Response> {
  const account = await getProtocolAccount(env.DB, id);
  if (!account) return json({ ok: false, errorCode: 404, description: "account not found", reason: "invalid_request" }, 404);
  return json({ ok: true, data: account });
}

export async function handleDeleteProtocolAccount(request: Request, env: Env, id: string): Promise<Response> {
  const account = await getProtocolAccount(env.DB, id);
  if (!account) return json({ ok: false, errorCode: 404, description: "account not found", reason: "invalid_request" }, 404);
  // Best-effort: also drop the session on the bridge so nothing lingers there.
  try {
    const bridge = await BridgeClient.fromSettings(env.DB);
    await bridge.logout(account.phone);
  } catch {
    // ignore — bridge may be unreachable; the local record is still deleted
  }
  await deleteProtocolAccount(env.DB, id);
  return json({ ok: true, data: null });
}

export async function handleListProtocolAccountTasks(env: Env, id: string): Promise<Response> {
  const account = await getProtocolAccount(env.DB, id);
  if (!account) return json({ ok: false, errorCode: 404, description: "account not found", reason: "invalid_request" }, 404);
  const tasks = await listTasksByProtocolAccount(env.DB, id);
  return json({ ok: true, data: tasks });
}

/** Asks the bridge which phones hold authorized sessions and updates status. */
export async function handleVerifyProtocolAccount(env: Env, id: string): Promise<Response> {
  const account = await getProtocolAccount(env.DB, id);
  if (!account) return json({ ok: false, errorCode: 404, description: "account not found", reason: "invalid_request" }, 404);
  try {
    const bridge = await BridgeClient.fromSettings(env.DB);
    const { accounts } = await bridge.health();
    const match = accounts.find((a) => a.phone === account.phone);
    const status = match ? (match.authorized ? "authorized" : "unauthorized") : "not_found";
    await updateProtocolAccountStatus(env.DB, id, status);
    return json({ ok: true, data: { ...account, status } });
  } catch (e) {
    await updateProtocolAccountStatus(env.DB, id, "unknown");
    return json(bridgeErr(e), 400);
  }
}

export async function handleSendCode(request: Request, env: Env, id: string): Promise<Response> {
  const account = await getProtocolAccount(env.DB, id);
  if (!account) return json({ ok: false, errorCode: 404, description: "account not found", reason: "invalid_request" }, 404);
  const body = (await request.json()) as { api_id?: string; api_hash?: string };
  if (!body.api_id || !body.api_hash) {
    return json({ ok: false, errorCode: 0, description: "api_id and api_hash are required", reason: "invalid_request" }, 400);
  }
  try {
    const bridge = await BridgeClient.fromSettings(env.DB);
    const result = await bridge.sendCode(account.phone, String(body.api_id), String(body.api_hash));
    // api_id/api_hash are passed through only — never persisted in D1.
    return json({ ok: true, data: result });
  } catch (e) {
    return json(bridgeErr(e), 400);
  }
}

export async function handleConfirmLogin(request: Request, env: Env, id: string): Promise<Response> {
  const account = await getProtocolAccount(env.DB, id);
  if (!account) return json({ ok: false, errorCode: 404, description: "account not found", reason: "invalid_request" }, 404);
  const body = (await request.json()) as { api_id?: string; api_hash?: string; code?: string; password?: string };
  if (!body.api_id || !body.api_hash || !body.code) {
    return json(
      { ok: false, errorCode: 0, description: "api_id, api_hash and code are required", reason: "invalid_request" },
      400,
    );
  }
  try {
    const bridge = await BridgeClient.fromSettings(env.DB);
    const result = await bridge.confirmLogin(
      account.phone,
      String(body.api_id),
      String(body.api_hash),
      String(body.code),
      body.password ? String(body.password) : undefined,
    );
    await updateProtocolAccountStatus(env.DB, id, "authorized");
    return json({ ok: true, data: result });
  } catch (e) {
    return json(bridgeErr(e), 400);
  }
}
