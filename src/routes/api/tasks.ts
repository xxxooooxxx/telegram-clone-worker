import { TelegramClient } from "../../telegram/client";
import { toResult } from "../../telegram/errors";
import { resolveLastN } from "../../jobs/resolveRange";
import { createBotRecord } from "./bots";
import { BridgeClient } from "../../protocol/bridgeClient";
import {
  findDuplicateProtocolTask,
  findDuplicateTask,
  getBotWithSecrets,
  getProtocolAccount,
  getTask,
  getTaskWithBot,
  insertSavedTask,
  insertTask,
  listActivityLog,
  listAllTasksSummary,
  listTasksByBot,
  updateTaskStatus,
  updateTaskConfig,
  deleteTask,
  PROTOCOL_BOT_SENTINEL,
} from "../../db/queries";
import type { BackfillStatus, TaskScope } from "../../shared/rpcTypes";

/** Sentinel path segment for POST /api/bots/:botId/tasks meaning "the bot
 * behind this task hasn't been saved yet — create it from botToken first."
 * Keeps the wizard from ever persisting a token before a task exists. */
const NEW_BOT_SENTINEL = "new";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export async function handleListAllTasks(env: Env): Promise<Response> {
  const tasks = await listAllTasksSummary(env.DB);
  return json({ ok: true, data: tasks });
}

export async function handleListTasks(env: Env, botId: string): Promise<Response> {
  const tasks = await listTasksByBot(env.DB, botId);
  return json({ ok: true, data: tasks });
}

export async function handleGetTaskById(env: Env, taskId: string): Promise<Response> {
  const task = await getTaskWithBot(env.DB, taskId);
  if (!task) return json({ ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" }, 404);
  return json({ ok: true, data: task });
}

export async function handleGetTaskActivity(env: Env, taskId: string): Promise<Response> {
  const log = await listActivityLog(env.DB, taskId);
  return json({ ok: true, data: log });
}

interface CreateTaskBody {
  botToken?: string;
  botLabel?: string;
  sourceChatId: string;
  sourceChatTitle?: string;
  destChatId: string;
  destChatTitle?: string;
  destChatType?: string;
  scope: TaskScope;
  backfillMode?: "range" | "lastN";
  startId?: number;
  endId?: number;
  n?: number;
  pacingBatchSize?: number;
  label?: string;
  allowDuplicate?: boolean;
  saveTemplate?: boolean;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
}

/** Evidence-based default from diagnostics testing (channel destination,
 * copyMessages): 40 and 60 messages/call completed cleanly (~590ms/message
 * sustained), 80 and 100 both hit a 429 after ~47s, landing at roughly the
 * same ~79-80-message ceiling regardless of how many were requested beyond
 * it. 60 is the largest confirmed-clean value. Previously groups defaulted
 * to a more conservative 20 (Telegram's documented group guidance, never
 * separately measured) since a rate-limit hit or a single unforwardable
 * message used to stall a task indefinitely — now that tick.ts pauses and
 * retries on 429 (see RATE_LIMIT_COOLDOWN_*) and drops a batch instead of
 * stalling on an unforwardable message, it's safe to use the same number
 * for every destination and let Telegram's actual responses govern the
 * real per-bot throughput instead of pre-guessing conservatively by type. */
const DEFAULT_PACING_BATCH_SIZE = 60;

export async function handleCreateTask(request: Request, env: Env, botId: string, origin: string): Promise<Response> {
  const body = (await request.json()) as CreateTaskBody;

  let resolvedBotId = botId;
  if (botId === NEW_BOT_SENTINEL) {
    if (!body.botToken) {
      return json({ ok: false, errorCode: 0, description: "botToken is required", reason: "invalid_request" }, 400);
    }
    const created = await createBotRecord(env, origin, body.botToken, body.botLabel);
    if (!created.ok) return json(created, 400);
    resolvedBotId = created.data.id;
  }

  const bot = await getBotWithSecrets(env.DB, resolvedBotId);
  if (!bot) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);

  const duplicate = await findDuplicateTask(env.DB, resolvedBotId, body.sourceChatId, body.destChatId);
  if (duplicate && !body.allowDuplicate) {
    return json(
      { ok: false, errorCode: 0, description: "a task with this source and destination already exists", reason: "invalid_request", duplicateTaskId: duplicate.id },
      409,
    );
  }

  const wantsBackfill = body.scope === "live_and_backfill" || body.scope === "backfill_only";
  const wantsLive = body.scope === "live" || body.scope === "live_and_backfill";

  const client = new TelegramClient(bot.token);

  const result = await toResult(async () => {
    let startId = body.startId ?? null;
    let endId = body.endId ?? null;

    if (wantsBackfill && body.backfillMode === "lastN") {
      const resolved = await resolveLastN(client, body.sourceChatId, body.n ?? 1);
      startId = resolved.startId;
      endId = resolved.endId;
    }

    const id = crypto.randomUUID();
    const label =
      body.label ?? `${body.sourceChatTitle ?? body.sourceChatId} → ${body.destChatTitle ?? body.destChatId}`;
    const pacingBatchSize = body.pacingBatchSize ?? DEFAULT_PACING_BATCH_SIZE;

    await insertTask(env.DB, {
      id,
      bot_id: resolvedBotId,
      label,
      source_chat_id: body.sourceChatId,
      source_chat_title: body.sourceChatTitle ?? null,
      dest_chat_id: body.destChatId,
      dest_chat_title: body.destChatTitle ?? null,
      scope: body.scope,
      live_enabled: wantsLive,
      backfill_mode: wantsBackfill ? (body.backfillMode ?? "range") : null,
      start_id: startId,
      end_id: endId,
      cursor: wantsBackfill ? startId : null,
      total: wantsBackfill && startId !== null && endId !== null ? endId - startId + 1 : null,
      backfill_status: wantsBackfill ? "running" : "not_applicable",
      pacing_batch_size: pacingBatchSize,
      filter_media_types: body.filterMediaTypes ?? null,
      filter_min_size_bytes: body.filterMinSizeBytes ?? null,
      filter_max_size_bytes: body.filterMaxSizeBytes ?? null,
    });

    if (body.saveTemplate) {
      // Best-effort: a saved-template write failure must not fail an
      // otherwise-successful task creation (no shared transaction here).
      try {
        await insertSavedTask(env.DB, {
          id: crypto.randomUUID(),
          task_id: id,
          bot_token: bot.token,
          bot_label: bot.label,
          bot_username: bot.bot_username,
          source_chat_id: body.sourceChatId,
          source_chat_title: body.sourceChatTitle ?? null,
          dest_chat_id: body.destChatId,
          dest_chat_title: body.destChatTitle ?? null,
          scope: body.scope,
          backfill_mode: wantsBackfill ? (body.backfillMode ?? "range") : null,
          start_id: startId,
          end_id: endId,
          n: wantsBackfill && body.backfillMode === "lastN" ? (body.n ?? null) : null,
          pacing_batch_size: pacingBatchSize,
          filter_media_types: body.filterMediaTypes ?? null,
          filter_min_size_bytes: body.filterMinSizeBytes ?? null,
          filter_max_size_bytes: body.filterMaxSizeBytes ?? null,
        });
      } catch (e) {
        console.error("saved_tasks write failed", e);
      }
    }

    return await getTask(env.DB, id);
  });

  return json(result, result.ok ? 201 : 400);
}

interface PatchTaskBody {
  label?: string;
  scope?: TaskScope;
  liveEnabled?: boolean;
  backfillStatus?: BackfillStatus;
  startId?: number | null;
  endId?: number | null;
  cursor?: number | null;
  resetProgress?: boolean;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
}

export async function handlePatchTask(request: Request, env: Env, taskId: string): Promise<Response> {
  const currentTask = await getTask(env.DB, taskId);
  if (!currentTask) {
    return json({ ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" }, 404);
  }

  const body = (await request.json()) as PatchTaskBody;

  // Resolve target scope and enablement
  const targetScope = body.scope ?? currentTask.scope;
  let liveEnabled = body.liveEnabled;
  let backfillStatus = body.backfillStatus;

  if (body.scope !== undefined) {
    if (body.scope === "live") {
      liveEnabled = liveEnabled !== undefined ? liveEnabled : true;
      backfillStatus = "not_applicable";
    } else if (body.scope === "backfill_only") {
      liveEnabled = false;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    } else if (body.scope === "live_and_backfill") {
      liveEnabled = liveEnabled !== undefined ? liveEnabled : true;
      if (!backfillStatus) {
        backfillStatus = currentTask.backfill_status === "not_applicable" ? "running" : currentTask.backfill_status;
      }
    }
  }

  // Backfill bounds calculation
  let startId = body.startId !== undefined ? body.startId : currentTask.start_id;
  let endId = body.endId !== undefined ? body.endId : currentTask.end_id;
  let cursor = body.cursor !== undefined ? body.cursor : currentTask.cursor;
  let total = currentTask.total;

  if (targetScope !== "live") {
    if (startId !== null && endId !== null) {
      if (startId > endId) {
        return json(
          { ok: false, errorCode: 400, description: "startId cannot be greater than endId", reason: "invalid_request" },
          400,
        );
      }
      total = endId - startId + 1;

      if (body.resetProgress) {
        cursor = startId;
        backfillStatus = "running";
      } else {
        // If startId increased past current cursor, bump cursor to startId
        if (cursor === null || cursor < startId) {
          cursor = startId;
        }
        // If endId increased past current cursor and task was complete, resume it
        if (cursor <= endId && (currentTask.backfill_status === "complete" || backfillStatus === "complete")) {
          backfillStatus = "running";
        }
      }
    }
  }

  // Filter configuration
  let filterMediaTypes = body.filterMediaTypes !== undefined ? body.filterMediaTypes : currentTask.filter_media_types;
  let filterMinSizeBytes = body.filterMinSizeBytes !== undefined ? body.filterMinSizeBytes : currentTask.filter_min_size_bytes;
  let filterMaxSizeBytes = body.filterMaxSizeBytes !== undefined ? body.filterMaxSizeBytes : currentTask.filter_max_size_bytes;

  // Backfill only scope does not use filters
  if (targetScope === "backfill_only") {
    filterMediaTypes = null;
    filterMinSizeBytes = null;
    filterMaxSizeBytes = null;
  }

  await updateTaskConfig(env.DB, taskId, {
    label: body.label,
    scope: targetScope,
    live_enabled: liveEnabled,
    backfill_status: backfillStatus,
    start_id: startId,
    end_id: endId,
    cursor,
    total,
    reset_progress: body.resetProgress,
    filter_media_types: filterMediaTypes,
    filter_min_size_bytes: filterMinSizeBytes,
    filter_max_size_bytes: filterMaxSizeBytes,
  });

  const task = await getTask(env.DB, taskId);
  return json({ ok: true, data: task });
}

export async function handleDeleteTask(env: Env, taskId: string): Promise<Response> {
  await deleteTask(env.DB, taskId);
  return json({ ok: true, data: null });
}

export async function handleTestCopy(env: Env, botId: string, taskId: string, messageId?: number): Promise<Response> {
  const bot = await getBotWithSecrets(env.DB, botId);
  const task = await getTask(env.DB, taskId);
  if (!bot || !task) return json({ ok: false, errorCode: 404, description: "not found", reason: "invalid_request" }, 404);

  const client = new TelegramClient(bot.token);
  const result = await toResult(async () => {
    let copyId = messageId;
    if (!copyId) {
      const latest = await resolveLastN(client, task.source_chat_id, 1);
      copyId = latest.endId;
    }
    return client.copyMessage(task.dest_chat_id, task.source_chat_id, copyId);
  });
  return json(result, result.ok ? 200 : 400);
}

/** Mode-aware test copy for any task — branches to the bridge for protocol tasks. */
export async function handleTestCopyAny(env: Env, taskId: string, messageId?: number): Promise<Response> {
  const task = await getTask(env.DB, taskId);
  if (!task) return json({ ok: false, errorCode: 404, description: "task not found", reason: "invalid_request" }, 404);

  if (task.mode === "protocol") {
    if (!task.protocol_account_id) {
      return json({ ok: false, errorCode: 0, description: "protocol task has no account", reason: "invalid_request" }, 400);
    }
    const account = await getProtocolAccount(env.DB, task.protocol_account_id);
    if (!account) {
      return json({ ok: false, errorCode: 404, description: "protocol account not found", reason: "invalid_request" }, 404);
    }
    const result = await toResult(async () => {
      const bridge = await BridgeClient.fromSettings(env.DB);
      let copyId = messageId;
      if (!copyId) copyId = await bridge.latestId(account.phone, task.source_chat_id);
      const res = await bridge.forwardBatch(account.phone, task.source_chat_id, task.dest_chat_id, [copyId]);
      if (res.copied.length === 0) throw new Error(res.failed[0]?.error ?? "forward failed");
      return { message_id: res.copied[0] };
    });
    return json(result, result.ok ? 200 : 400);
  }

  const bot = await getBotWithSecrets(env.DB, task.bot_id);
  if (!bot) return json({ ok: false, errorCode: 404, description: "bot not found", reason: "invalid_request" }, 404);
  return handleTestCopy(env, bot.id, taskId, messageId);
}

interface CreateProtocolTaskBody {
  protocolAccountId: string;
  sourceChatId: string;
  sourceChatTitle?: string;
  destChatId: string;
  destChatTitle?: string;
  scope: TaskScope;
  backfillMode?: "range" | "lastN";
  startId?: number;
  endId?: number;
  n?: number;
  pacingBatchSize?: number;
  label?: string;
  allowDuplicate?: boolean;
  filterMediaTypes?: string | null;
  filterMinSizeBytes?: number | null;
  filterMaxSizeBytes?: number | null;
}

/** Creates a protocol-mode task. Mirrors handleCreateTask minus the bot
 * lifecycle: no token verification here (the account was verified via
 * /verify when it was added), no saved-task templates. */
export async function handleCreateProtocolTask(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as CreateProtocolTaskBody;

  if (!body.protocolAccountId || !body.sourceChatId || !body.destChatId || !body.scope) {
    return json(
      { ok: false, errorCode: 0, description: "protocolAccountId, sourceChatId, destChatId and scope are required", reason: "invalid_request" },
      400,
    );
  }

  const account = await getProtocolAccount(env.DB, body.protocolAccountId);
  if (!account) return json({ ok: false, errorCode: 404, description: "protocol account not found", reason: "invalid_request" }, 404);

  const duplicate = await findDuplicateProtocolTask(env.DB, account.id, body.sourceChatId, body.destChatId);
  if (duplicate && !body.allowDuplicate) {
    return json(
      { ok: false, errorCode: 0, description: "a task with this source and destination already exists", reason: "invalid_request", duplicateTaskId: duplicate.id },
      409,
    );
  }

  const wantsBackfill = body.scope === "live_and_backfill" || body.scope === "backfill_only";
  const wantsLive = body.scope === "live" || body.scope === "live_and_backfill";

  const result = await toResult(async () => {
    const bridge = await BridgeClient.fromSettings(env.DB);

    let startId = body.startId ?? null;
    let endId = body.endId ?? null;

    if (wantsBackfill && body.backfillMode === "lastN") {
      // Protocol path has no probe-and-delete trick — the bridge reads the
      // channel's latest message id directly.
      const latest = await bridge.latestId(account.phone, body.sourceChatId);
      const n = body.n ?? 1;
      endId = latest;
      startId = Math.max(1, latest - n + 1);
    }

    const id = crypto.randomUUID();
    const label =
      body.label ?? `${body.sourceChatTitle ?? body.sourceChatId} → ${body.destChatTitle ?? body.destChatId}`;
    const pacingBatchSize = body.pacingBatchSize ?? 50;

    await insertTask(env.DB, {
      id,
      bot_id: PROTOCOL_BOT_SENTINEL,
      mode: "protocol",
      protocol_account_id: account.id,
      label,
      source_chat_id: body.sourceChatId,
      source_chat_title: body.sourceChatTitle ?? null,
      dest_chat_id: body.destChatId,
      dest_chat_title: body.destChatTitle ?? null,
      scope: body.scope,
      live_enabled: wantsLive,
      backfill_mode: wantsBackfill ? (body.backfillMode ?? "range") : null,
      start_id: startId,
      end_id: endId,
      cursor: wantsBackfill ? startId : null,
      total: wantsBackfill && startId !== null && endId !== null ? endId - startId + 1 : null,
      backfill_status: wantsBackfill ? "running" : "not_applicable",
      pacing_batch_size: pacingBatchSize,
      filter_media_types: body.filterMediaTypes ?? null,
      filter_min_size_bytes: body.filterMinSizeBytes ?? null,
      filter_max_size_bytes: body.filterMaxSizeBytes ?? null,
    });

    return await getTask(env.DB, id);
  });

  return json(result, result.ok ? 201 : 400);
}
