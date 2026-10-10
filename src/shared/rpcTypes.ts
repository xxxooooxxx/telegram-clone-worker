export type ErrorReason =
  | "insufficient_permissions"
  | "bot_not_in_chat"
  | "rate_limited"
  | "invalid_request"
  | "unauthorized"
  | "unknown";

export type Result<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      errorCode: number;
      description: string;
      reason: ErrorReason;
      retryAfter?: number;
    };

export interface BotSummary {
  id: string;
  bot_id: number;
  bot_username: string;
  label: string;
  created_at: number;
}

/** Result of a token check — see handleVerifyBot. */
export interface BotVerifyResult {
  bot_id: number;
  bot_username: string;
  existing_bot_id: string | null;
  active_tasks: TaskSummary[];
  total_tasks_count: number;
}

export type TaskScope = "live" | "live_and_backfill" | "backfill_only";
export type TaskMode = "bot" | "protocol";
export type BackfillStatus =
  | "not_applicable"
  | "pending"
  | "running"
  | "paused"
  | "complete"
  | "cancelled"
  | "failed";

export interface ProtocolAccountSummary {
  id: string;
  label: string;
  phone: string;
  status: string;
  created_at: number;
}

export interface TaskSummary {
  id: string;
  bot_id: string;
  mode: TaskMode;
  protocol_account_id: string | null;
  label: string;
  source_chat_id: string;
  source_chat_title: string | null;
  dest_chat_id: string;
  dest_chat_title: string | null;
  scope: TaskScope;
  live_enabled: boolean;
  backfill_mode: "range" | "lastN" | null;
  start_id: number | null;
  end_id: number | null;
  cursor: number | null;
  total: number | null;
  processed: number;
  failed: number;
  live_processed: number;
  live_failed: number;
  live_skipped: number;
  filter_media_types: string | null;
  filter_min_size_bytes: number | null;
  filter_max_size_bytes: number | null;
  pending_count?: number;
  backfill_status: BackfillStatus;
  pacing_batch_size: number;
  stop_reason: ErrorReason | null;
  stopped_at: number | null;
  rate_limited_until: number | null;
  created_at: number;
}

export interface TaskDetail extends TaskSummary {
  bot_username: string;
}

export interface BridgeConfigResponse {
  url: string | null;
  configured: boolean;
}

export interface CapabilityEntry {
  key: string;
  label: string;
  available: boolean;
  reason?: string;
}

export interface SourceTaskHistory {
  id: string;
  bot_id: string;
  bot_username: string;
  bot_label: string;
  label: string;
  dest_chat_id: string;
  dest_chat_title: string | null;
  scope: TaskScope;
  backfill_mode: "range" | "lastN" | null;
  start_id: number | null;
  end_id: number | null;
  cursor: number | null;
  total: number | null;
  processed: number;
  failed: number;
  live_processed?: number;
  live_failed?: number;
  backfill_status: BackfillStatus;
  live_enabled: boolean;
  stop_reason: ErrorReason | null;
  stopped_at: number | null;
  created_at: number;
  last_copied_message_id: number | null;
  last_activity_at: number | null;
}

export interface ChatLookupResult {
  chat: { id: number; type: string; title?: string; username?: string };
  botStatus: string;
  capabilities: CapabilityEntry[];
  memberCount?: number;
  admins?: Array<{ id: number; name: string; status: string; is_bot: boolean }>;
  pastTasks?: SourceTaskHistory[];
}

// Saved Tasks

export interface SavedTaskSummary {
  id: string;
  task_id: string | null;
  bot_label: string;
  bot_username: string;
  token_preview: string;
  source_chat_id: string;
  source_chat_title: string | null;
  dest_chat_id: string;
  dest_chat_title: string | null;
  scope: TaskScope;
  backfill_mode: "range" | "lastN" | null;
  start_id: number | null;
  end_id: number | null;
  n: number | null;
  pacing_batch_size: number;
  filter_media_types: string | null;
  filter_min_size_bytes: number | null;
  filter_max_size_bytes: number | null;
  created_at: number;
}

export interface SavedTaskWithToken extends SavedTaskSummary {
  bot_token: string;
}

// Authentication

export type AuthMode = "enforced" | "open";
export type AuthSource = "env" | "d1" | "none";

export interface AuthStatusResponse {
  mode: AuthMode;
  source: AuthSource;
  authenticated: boolean;
}

export interface AuthLoginResponse {
  token: string;
}
