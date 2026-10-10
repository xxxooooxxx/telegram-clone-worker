import { BridgeClient, BridgeError, type BridgeMessage } from "../protocol/bridgeClient";
import type { TelegramMessage } from "../telegram/types";
import {
  advanceLiveCursor,
  advanceTaskProgress,
  appendActivityLog,
  claimTask,
  deletePendingMessages,
  getProtocolAccount,
  getTask,
  incrementLiveCounters,
  insertPendingMessage,
  listPendingMessages,
  pauseBotForRateLimit,
  pruneActivityLog,
  releaseTaskLease,
  stopTasksForProtocolAccount,
  type PendingMessageRow,
} from "../db/queries";
import type { ProtocolAccountSummary, TaskSummary } from "../shared/rpcTypes";
import { evaluateMessageFilter, extractMessageMetadata, formatBytes, getMediaIcon } from "../shared/messageFilter";
import { RATE_LIMIT_COOLDOWN_MAX_SECONDS, RATE_LIMIT_COOLDOWN_MIN_SECONDS } from "./tick";

// Cloudflare: "Each Worker invocation can have up to six connections
// simultaneously waiting for response headers." (see tick.ts) — the bridge
// is one HTTP call at a time per account group, well within that budget.
const LEASE_SECONDS = 240;

/** Builds a minimal TelegramMessage-shaped object from a bridge message so
 * the shared filter/metadata helpers work unchanged for protocol tasks. */
function bridgeMessageToTelegramMessage(m: BridgeMessage): TelegramMessage {
  const msg = {
    message_id: m.id,
    date: m.date ? Math.floor(new Date(m.date).getTime() / 1000) : 0,
    chat: { id: 0, type: "channel" },
    text: m.text ?? undefined,
  } as TelegramMessage;
  const media = m.media;
  if (media) {
    if (media.type === "photo") {
      msg.photo = [{ file_id: "", width: 0, height: 0, file_size: media.size ?? 0 }];
    } else if (media.type === "video") {
      msg.video = { file_id: "", file_size: media.size ?? 0, file_name: media.name ?? undefined };
    } else if (media.type === "audio") {
      msg.audio = { file_id: "", file_size: media.size ?? 0, file_name: media.name ?? undefined };
    } else if (media.type === "voice") {
      msg.voice = { file_id: "", file_size: media.size ?? 0 };
    } else if (media.type === "animation") {
      msg.animation = { file_id: "", file_size: media.size ?? 0, file_name: media.name ?? undefined };
    } else {
      msg.document = { file_id: "", file_size: media.size ?? 0, file_name: media.name ?? undefined };
    }
  }
  return msg;
}

async function stopAccountTasks(env: Env, account: ProtocolAccountSummary): Promise<void> {
  const stopped = await stopTasksForProtocolAccount(env.DB, account.id, "unauthorized");
  for (const t of stopped) {
    await appendActivityLog(env.DB, {
      task_id: t.id,
      kind: "backfill_batch",
      detail: `protocol session unauthorized — task auto-stopped (${t.processed} copied, ${t.failed} failed before stopping)`,
      ok: false,
      error: "401 Unauthorized",
    });
  }
}

/** Live sync for one protocol task: poll the bridge for messages newer than
 * the task's watermark and buffer matches into task_pending_messages.
 * Unlike bot tasks (which advance a per-bot getUpdates offset), protocol
 * tasks track their own high-water mark in `cursor` — except while a
 * backfill owns the cursor, in which case we dedup against the pending
 * queue instead of advancing it.
 *
 * The cursor is refetched from D1 (not taken from the tick-start snapshot):
 * live sync runs before this tick's backfill batches, so using the current
 * value guarantees the synced range never overlaps ids the backfill is
 * about to copy — otherwise messages would be forwarded twice. */
async function syncProtocolLive(
  env: Env,
  bridge: BridgeClient,
  account: ProtocolAccountSummary,
  task: TaskSummary,
): Promise<void> {
  const fresh = await getTask(env.DB, task.id);
  if (!fresh || !fresh.live_enabled) return;
  const sinceId = fresh.cursor ?? 0;
  const backfillRunning = fresh.backfill_status === "running";
  const messages = await bridge.sync(account.phone, fresh.source_chat_id, sinceId, 100);
  if (messages.length === 0) return;

  let bufferedIds: Set<number> | null = null;
  const isBuffered = async (id: number): Promise<boolean> => {
    if (!bufferedIds) {
      const rows = await listPendingMessages(env.DB, task.id, 500);
      bufferedIds = new Set(rows.map((r) => r.message_id));
    }
    return bufferedIds.has(id);
  };

  const ownsCursor = !backfillRunning;
  let maxId = sinceId;

  for (const m of messages) {
    if (m.id > maxId) maxId = m.id;
    if (await isBuffered(m.id)) continue;

    const fake = bridgeMessageToTelegramMessage(m);
    const meta = extractMessageMetadata(fake);
    const icon = getMediaIcon(meta.type);
    const sizeStr = meta.size ? formatBytes(meta.size) : "";
    const fileDesc = [icon, sizeStr, meta.name ? `(${meta.name})` : ""].filter(Boolean).join(" ");

    const filterMediaTypes = fresh.filter_media_types
      ? fresh.filter_media_types.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const evalResult = evaluateMessageFilter(fake, {
      mediaTypes: filterMediaTypes,
      minSizeBytes: fresh.filter_min_size_bytes,
      maxSizeBytes: fresh.filter_max_size_bytes,
    });

    if (!evalResult.matched) {
      await incrementLiveCounters(env.DB, task.id, 0, 0, 1);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "live_forward",
        detail: `${fileDesc} · msg #${m.id} skipped: ${evalResult.reason}`,
        ok: false,
        error: `Filtered: ${evalResult.reason}`,
      });
      continue;
    }

    await insertPendingMessage(env.DB, task.id, m.id, meta.type, meta.size ?? null, meta.name ?? null);

    if (backfillRunning) {
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "live_forward",
        detail: `⏳ Queued in buffer: ${fileDesc} · msg #${m.id} (waiting for backfill to finish)`,
        ok: true,
      });
    }
  }

  if (ownsCursor && maxId > sinceId) {
    await advanceLiveCursor(env.DB, task.id, maxId);
    task.cursor = maxId;
  }
}

/** Protocol twin of tick.ts's processOneBatch: forwards one id range via the
 * bridge. Returns true when the rest of this account's tasks should be
 * skipped for the remainder of this tick (rate-limited or session dead). */
async function processOneProtocolBatch(
  env: Env,
  bridge: BridgeClient,
  account: ProtocolAccountSummary,
  task: TaskSummary,
): Promise<boolean> {
  if (task.cursor === null || task.end_id === null) return false;

  const batchStartedAtMs = Date.now();
  const batchEnd = Math.min(task.cursor + task.pacing_batch_size - 1, task.end_id);
  const messageIds: number[] = [];
  for (let id = task.cursor; id <= batchEnd; id++) messageIds.push(id);

  let copied = 0;
  let failedCount = 0;
  let failureNotes: string | undefined;
  try {
    const res = await bridge.forwardBatch(account.phone, task.source_chat_id, task.dest_chat_id, messageIds);
    copied = res.copied.length;
    failedCount = res.failed.length;
    if (failedCount > 0) {
      failureNotes = res.failed.slice(0, 3).map((f) => `#${f.id}: ${f.error}`).join("; ");
    }
  } catch (e) {
    if (e instanceof BridgeError && e.reason === "rate_limited") {
      const waitSeconds = Math.min(
        Math.max(e.retryAfter ?? 0, RATE_LIMIT_COOLDOWN_MIN_SECONDS),
        RATE_LIMIT_COOLDOWN_MAX_SECONDS,
      );
      await pauseBotForRateLimit(env.DB, account.id, Math.floor(Date.now() / 1000) + waitSeconds);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "backfill_batch",
        detail: `ids ${task.cursor}-${batchEnd}: rate limited, pausing account for ${waitSeconds}s`,
        ok: true,
      });
      return true;
    }
    if (e instanceof BridgeError && e.reason === "unauthorized") {
      await stopAccountTasks(env, account);
      return true;
    }
    const message = e instanceof Error ? e.message : String(e);
    await appendActivityLog(env.DB, {
      task_id: task.id,
      kind: "backfill_batch",
      detail: `ids ${task.cursor}-${batchEnd}: ${e instanceof BridgeError ? e.reason : "unexpected error"}, resuming next tick`,
      ok: false,
      error: message,
    });
    return false;
  }

  const batchDurationMs = Date.now() - batchStartedAtMs;
  const newCursor = batchEnd + 1;
  const wasBackfilling = task.backfill_status !== "complete";

  let newProcessed = task.processed;
  let newFailed = task.failed;
  let newLiveProcessed = task.live_processed ?? 0;
  let newLiveFailed = task.live_failed ?? 0;
  if (wasBackfilling) {
    newProcessed += copied;
    newFailed += failedCount;
  } else {
    newLiveProcessed += copied;
    newLiveFailed += failedCount;
  }

  const progressResult = await advanceTaskProgress(env.DB, task.id, {
    cursor: newCursor,
    processed: newProcessed,
    failed: newFailed,
    live_processed: newLiveProcessed,
    live_failed: newLiveFailed,
  });

  const justCompletedBackfill = wasBackfilling && progressResult.complete;
  const isLiveScope = task.scope === "live" || (task.scope === "live_and_backfill" && !wasBackfilling);
  await appendActivityLog(env.DB, {
    task_id: task.id,
    kind: isLiveScope ? "live_forward" : "backfill_batch",
    detail: `ids ${task.cursor}-${batchEnd}: ${copied} ok, ${failedCount} failed, took ${batchDurationMs}ms (protocol)${justCompletedBackfill ? " (backfill complete)" : ""}`,
    ok: true,
    error: failureNotes,
  });

  if (progressResult.complete || Math.random() < 0.05) {
    await pruneActivityLog(env.DB, task.id);
  }
  return false;
}

/** Drains one protocol task's buffered live messages via the bridge. */
export async function drainProtocolPending(
  env: Env,
  task: TaskSummary,
  pending: PendingMessageRow[],
): Promise<boolean> {
  if (!task.protocol_account_id) return false;
  const account = await getProtocolAccount(env.DB, task.protocol_account_id);
  if (!account) return false;
  let bridge: BridgeClient;
  try {
    bridge = await BridgeClient.fromSettings(env.DB);
  } catch {
    return false;
  }

  for (const item of pending) {
    const icon = getMediaIcon(item.media_type ?? "text");
    const sizeStr = item.file_size ? formatBytes(item.file_size) : "";
    const fileDesc = [icon, sizeStr, item.file_name ? `(${item.file_name})` : ""].filter(Boolean).join(" ");

    try {
      const res = await bridge.forwardBatch(account.phone, task.source_chat_id, task.dest_chat_id, [item.message_id]);
      if (res.copied.length === 0) {
        throw new BridgeError("invalid_request", res.failed[0]?.error ?? "forward failed");
      }
      await deletePendingMessages(env.DB, [item.id]);
      await incrementLiveCounters(env.DB, task.id, 1, 0, 0);
      await appendActivityLog(env.DB, {
        task_id: task.id,
        kind: "live_forward",
        detail: `Copied ${fileDesc} · msg #${item.message_id} (delivered from live queue, protocol)`,
        ok: true,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (e instanceof BridgeError && e.reason === "rate_limited") {
        const waitSeconds = Math.min(
          Math.max(e.retryAfter ?? 0, RATE_LIMIT_COOLDOWN_MIN_SECONDS),
          RATE_LIMIT_COOLDOWN_MAX_SECONDS,
        );
        await pauseBotForRateLimit(env.DB, account.id, Math.floor(Date.now() / 1000) + waitSeconds);
        return true;
      }
      if (e instanceof BridgeError && e.reason === "unauthorized") {
        await stopAccountTasks(env, account);
        return true;
      }
      if (e instanceof BridgeError && error.toLowerCase().includes("not found")) {
        await deletePendingMessages(env.DB, [item.id]);
        await appendActivityLog(env.DB, {
          task_id: task.id,
          kind: "live_forward",
          detail: `msg #${item.message_id}: not found in source, removed from queue`,
          ok: false,
          error,
        });
      }
      break;
    }
  }
  return false;
}

/** Runs one protocol-account group (live sync + backfill batches).
 * Returns the number of backfill batches run. */
export async function runProtocolGroup(env: Env, groupTasks: TaskSummary[]): Promise<number> {
  const accountId = groupTasks[0].protocol_account_id;
  if (!accountId) return 0;
  const account = await getProtocolAccount(env.DB, accountId);
  if (!account) return 0;

  let bridge: BridgeClient;
  try {
    bridge = await BridgeClient.fromSettings(env.DB);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const t of groupTasks) {
      await appendActivityLog(env.DB, {
        task_id: t.id,
        kind: "backfill_batch",
        detail: "protocol bridge not configured — set Bridge URL + Secret first",
        ok: false,
        error: msg,
      });
    }
    return 0;
  }

  // 1. Live sync: poll the bridge for messages newer than each task's watermark.
  for (const t of groupTasks) {
    if (!t.live_enabled) continue;
    try {
      await syncProtocolLive(env, bridge, account, t);
    } catch (e) {
      if (e instanceof BridgeError && e.reason === "unauthorized") {
        console.warn(`tick: protocol account ${account.phone} unauthorized, stopping its tasks.`);
        await stopAccountTasks(env, account);
        return 0;
      }
      console.error(`tick: protocol live sync failed for task ${t.id}`, e);
    }
  }

  // 2. Backfill batches — same claim/lease flow as bot tasks.
  let batchesRun = 0;
  for (const task of groupTasks) {
    // If backfill was running but cursor has already caught up to or passed end_id, mark complete
    if (task.backfill_status === "running" && task.cursor !== null && task.end_id !== null && task.cursor > task.end_id) {
      const res = await advanceTaskProgress(env.DB, task.id, {
        cursor: task.cursor,
        processed: task.processed,
        failed: task.failed,
        backfill_status: "complete",
      });
      task.backfill_status = res.backfill_status;
    }

    if (task.cursor === null || task.end_id === null || task.cursor > task.end_id) continue;

    const claimed = await claimTask(env.DB, task.id, LEASE_SECONDS);
    if (!claimed) continue;
    try {
      batchesRun++;
      const skipGroupForRest = await processOneProtocolBatch(env, bridge, account, claimed);
      if (skipGroupForRest) break;
    } catch (e) {
      console.error(`tick: protocol task ${claimed.id} failed`, e);
    } finally {
      await releaseTaskLease(env.DB, claimed.id);
    }
  }
  return batchesRun;
}
