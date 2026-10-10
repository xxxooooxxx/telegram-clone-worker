import type { ErrorReason } from "../shared/rpcTypes";

/** Mirrors the bridge's error taxonomy (bridge/README.md). Classified the
 * same way TelegramApiError is, so tick.ts can reuse its failure handling. */
export class BridgeError extends Error {
  reason: ErrorReason;
  retryAfter?: number;

  constructor(reason: ErrorReason, message: string, retryAfter?: number) {
    super(message);
    this.name = "BridgeError";
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}

export interface BridgeMessageMedia {
  type: string;
  size?: number | null;
  name?: string | null;
}

export interface BridgeMessage {
  id: number;
  date?: string | null;
  text?: string | null;
  media?: BridgeMessageMedia | null;
}

export interface BridgeChatInfo {
  id: number;
  title?: string | null;
  type: string;
  username?: string | null;
}

export interface ForwardBatchResult {
  copied: number[];
  failed: { id: number; error: string }[];
}

const BRIDGE_MAX_BATCH = 50;

async function readBridgeConfig(db: D1Database): Promise<{ url: string; secret: string }> {
  const rows = await db
    .prepare(`SELECT key, value FROM app_settings WHERE key IN ('bridge_url', 'bridge_secret')`)
    .all<{ key: string; value: string }>();
  const map = new Map((rows.results ?? []).map((r) => [r.key, r.value]));
  const url = (map.get("bridge_url") ?? "").replace(/\/+$/, "");
  const secret = map.get("bridge_secret") ?? "";
  if (!url || !secret) {
    throw new BridgeError("invalid_request", "protocol bridge is not configured (set Bridge URL + Secret first)");
  }
  return { url, secret };
}

export class BridgeClient {
  private constructor(
    private url: string,
    private secret: string,
  ) {}

  static async fromSettings(db: D1Database): Promise<BridgeClient> {
    const { url, secret } = await readBridgeConfig(db);
    return new BridgeClient(url, secret);
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bridge-secret": this.secret },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new BridgeError("unknown", `bridge unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    let data: Record<string, unknown>;
    try {
      data = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new BridgeError("unknown", `bridge returned non-JSON (HTTP ${res.status})`);
    }
    if (data.ok !== true || res.status >= 400) {
      throw this.classify(res.status, data);
    }
    return data as T;
  }

  private classify(status: number, data: Record<string, unknown>): BridgeError {
    const code = String(data.error ?? "");
    const message = String(data.message ?? `bridge error (HTTP ${status})`);
    const retryAfter = typeof data.retry_after === "number" ? data.retry_after : undefined;
    if (status === 401 || code === "unauthorized") return new BridgeError("unauthorized", message);
    if (status === 429 || code === "rate_limited") return new BridgeError("rate_limited", message, retryAfter);
    if (status === 404 || code === "not_found") return new BridgeError("invalid_request", message);
    if (status === 400 || code === "invalid_request" || code === "2fa_required" || code === "misconfigured") {
      return new BridgeError("invalid_request", message);
    }
    return new BridgeError("unknown", message);
  }

  async health(): Promise<{ accounts: { phone: string; authorized: boolean }[] }> {
    const res = await fetch(`${this.url}/health`, {
      headers: { "x-bridge-secret": this.secret },
    });
    if (!res.ok) throw new BridgeError("unknown", `bridge health check failed (HTTP ${res.status})`);
    const data = (await res.json()) as { ok: boolean; accounts: { phone: string; authorized: boolean }[] };
    return { accounts: data.accounts ?? [] };
  }

  async sendCode(phone: string, api_id: string, api_hash: string): Promise<{ already_authorized: boolean }> {
    const data = await this.call<{ already_authorized?: boolean }>("/accounts/login/send-code", {
      phone,
      api_id,
      api_hash,
    });
    return { already_authorized: data.already_authorized === true };
  }

  async confirmLogin(
    phone: string,
    api_id: string,
    api_hash: string,
    code: string,
    password?: string,
  ): Promise<{ user_id?: number | null; username?: string | null }> {
    return this.call("/accounts/login/confirm", { phone, api_id, api_hash, code, password });
  }

  async logout(phone: string): Promise<void> {
    await this.call("/accounts/logout", { phone });
  }

  async resolve(phone: string, chat: string): Promise<BridgeChatInfo> {
    return this.call("/resolve", { phone, chat });
  }

  async latestId(phone: string, chat: string): Promise<number> {
    const data = await this.call<{ latest_id: number }>("/latest-id", { phone, chat });
    return data.latest_id;
  }

  /** Forwards ids via the bridge, chunked to the bridge's 50-id cap. */
  async forwardBatch(
    phone: string,
    source: string,
    dest: string,
    ids: number[],
    dropAuthor = false,
  ): Promise<ForwardBatchResult> {
    const copied: number[] = [];
    const failed: { id: number; error: string }[] = [];
    for (let i = 0; i < ids.length; i += BRIDGE_MAX_BATCH) {
      const chunk = ids.slice(i, i + BRIDGE_MAX_BATCH);
      const data = await this.call<ForwardBatchResult>("/forward-batch", {
        phone,
        source,
        dest,
        ids: chunk,
        drop_author: dropAuthor,
      });
      copied.push(...data.copied);
      failed.push(...data.failed);
    }
    return { copied, failed };
  }

  async sync(phone: string, chat: string, sinceId: number, limit = 100): Promise<BridgeMessage[]> {
    const data = await this.call<{ messages: BridgeMessage[] }>("/sync", {
      phone,
      chat,
      since_id: sinceId,
      limit,
    });
    return data.messages ?? [];
  }

  async sendTest(phone: string, chat: string, text: string): Promise<{ message_id: number }> {
    return this.call("/send-test", { phone, chat, text });
  }
}
