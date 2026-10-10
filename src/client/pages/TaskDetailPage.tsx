import { useCallback, useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useToast } from "../components/Toast";
import { PageHero } from "../components/PageHero";
import { Badge } from "../components/Badge";
import { PermissionErrorBanner } from "../components/PermissionErrorBanner";
import { navigate } from "../lib/router";
import { useTasks, getTaskDisplayInfo } from "../lib/useTasksContext";
import { formatBytes, getMediaIcon } from "../../shared/messageFilter";
import type { TaskDetail, TaskScope, TaskSummary } from "../../shared/rpcTypes";

interface ActivityEntry {
  id: number;
  kind: "live_forward" | "backfill_batch";
  detail: string | null;
  ok: number;
  error: string | null;
  at: number;
}

export function TaskDetailPage({ taskId }: { taskId: string }) {
  const toast = useToast();
  const { refetch: refetchGlobalTasks } = useTasks();
  const fetchTask = useCallback(() => api.get<TaskDetail>(`/api/tasks/${taskId}`), [taskId]);
  const { data: task, loading, refetch } = usePolling(fetchTask, 4000, [taskId]);

  const fetchActivity = useCallback(() => api.get<ActivityEntry[]>(`/api/tasks/${taskId}/activity`), [taskId]);
  const { data: activity } = usePolling(fetchActivity, 5000, [taskId]);

  const [testCopyResult, setTestCopyResult] = useState<string | null>(null);
  const [testingCopy, setTestingCopy] = useState(false);
  const [testMessageId, setTestMessageId] = useState("");

  // Edit Task Modal State
  const [isEditing, setIsEditing] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editScope, setEditScope] = useState<TaskScope>("live");
  const [editStartId, setEditStartId] = useState("");
  const [editEndId, setEditEndId] = useState("");
  const [editCursor, setEditCursor] = useState("");
  const [resetProgress, setResetProgress] = useState(false);
  const [enableFilters, setEnableFilters] = useState(false);
  const [filterMediaTypes, setFilterMediaTypes] = useState<string[]>([]);
  const [minFileSizeMb, setMinFileSizeMb] = useState("");
  const [maxFileSizeMb, setMaxFileSizeMb] = useState("");

  function openEditModal() {
    if (!task) return;
    setEditLabel(task.label);
    setEditScope(task.scope);
    setEditStartId(task.start_id != null ? String(task.start_id) : "");
    setEditEndId(task.end_id != null ? String(task.end_id) : "");
    setEditCursor(task.cursor != null ? String(task.cursor) : "");
    setResetProgress(false);

    const hasAnyFilter = Boolean(task.filter_media_types || task.filter_min_size_bytes || task.filter_max_size_bytes);
    setEnableFilters(hasAnyFilter);
    setFilterMediaTypes(task.filter_media_types ? task.filter_media_types.split(",").map((t) => t.trim()).filter(Boolean) : []);
    setMinFileSizeMb(task.filter_min_size_bytes ? String(Math.round(task.filter_min_size_bytes / (1024 * 1024))) : "");
    setMaxFileSizeMb(task.filter_max_size_bytes ? String(Math.round(task.filter_max_size_bytes / (1024 * 1024))) : "");

    setIsEditing(true);
  }

  async function handleSaveEdit() {
    if (!task) return;

    const wantsBackfill = editScope === "backfill_only" || editScope === "live_and_backfill";
    const wantsLive = editScope === "live" || editScope === "live_and_backfill";

    let startId: number | null = null;
    let endId: number | null = null;
    let cursor: number | null = null;

    if (wantsBackfill) {
      if (!editStartId || !editEndId) {
        toast.show("error", "Start ID and End ID are required for backfill");
        return;
      }
      startId = Number(editStartId);
      endId = Number(editEndId);
      if (isNaN(startId) || isNaN(endId)) {
        toast.show("error", "Start ID and End ID must be valid numbers");
        return;
      }
      if (startId > endId) {
        toast.show("error", "Start ID cannot be greater than End ID");
        return;
      }
      if (editCursor && !resetProgress) {
        cursor = Number(editCursor);
        if (isNaN(cursor)) {
          toast.show("error", "Cursor must be a valid number");
          return;
        }
      }
    }

    const minBytes = wantsLive && enableFilters && minFileSizeMb ? Math.round(Number(minFileSizeMb) * 1024 * 1024) : null;
    const maxBytes = wantsLive && enableFilters && maxFileSizeMb ? Math.round(Number(maxFileSizeMb) * 1024 * 1024) : null;
    const mediaTypesStr = wantsLive && enableFilters && filterMediaTypes.length > 0 ? filterMediaTypes.join(",") : null;

    setSavingEdit(true);
    const res = await api.patch<TaskSummary>(`/api/tasks/${taskId}`, {
      label: editLabel.trim() || undefined,
      scope: editScope,
      startId,
      endId,
      cursor,
      resetProgress,
      filterMediaTypes: mediaTypesStr,
      filterMinSizeBytes: minBytes,
      filterMaxSizeBytes: maxBytes,
    });
    setSavingEdit(false);

    if (res.ok) {
      toast.show("success", "Task updated successfully");
      setIsEditing(false);
      refetch();
      refetchGlobalTasks();
    } else {
      toast.show("error", res.description);
    }
  }

  if (!task) {
    if (loading) {
      return (
        <div className="content-container">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      );
    }
    return (
      <div className="content-container">
        <div className="card" style={{ textAlign: "center", padding: "40px 20px" }}>
          <h3 style={{ fontSize: 16, marginBottom: 8 }}>Task Not Found</h3>
          <p className="text-muted" style={{ marginBottom: 20 }}>
            This task could not be loaded or may have been deleted.
          </p>
          <button className="btn btn-primary" onClick={() => navigate("")}>
            ← Back to Tasks
          </button>
        </div>
      </div>
    );
  }

  const isBackfillComplete = task.backfill_status === "complete";
  const scannedCount = isBackfillComplete
    ? (task.total ?? 0)
    : Math.min(task.total ?? 0, (task.processed ?? 0) + (task.failed ?? 0));
  const rangeScannedPct =
    task.total && task.total > 0
      ? Math.min(100, Math.round((scannedCount / task.total) * 100))
      : 0;

  async function patch(body: Partial<{ liveEnabled: boolean; backfillStatus: "running" | "paused" | "cancelled" }>) {
    const res = await api.patch<TaskSummary>(`/api/tasks/${taskId}`, body);
    if (res.ok) {
      refetch();
      refetchGlobalTasks();
    } else {
      toast.show("error", res.description);
    }
  }

  async function runTestCopy() {
    if (!task) return;
    setTestingCopy(true);
    setTestCopyResult(null);
    const url =
      task.mode === "protocol"
        ? `/api/tasks/${task.id}/test-copy`
        : `/api/bots/${task.bot_id}/tasks/${task.id}/test-copy`;
    const res = await api.post<{ message_id: number }>(url, {
      messageId: testMessageId ? Number(testMessageId) : undefined,
    });
    setTestingCopy(false);
    setTestCopyResult(
      res.ok
        ? `✓ Sent as message #${res.data.message_id} in destination`
        : `✗ Failed: ${res.description}`,
    );
  }

  const displayInfo = task ? getTaskDisplayInfo(task) : null;
  const displayTitle = displayInfo?.title ?? task?.label ?? "";

  async function removeTask() {
    if (!task) return;
    if (!confirm(`Delete task "${displayTitle}"? This can't be undone.`)) return;
    const res = await api.del(`/api/tasks/${taskId}`);
    if (res.ok) {
      toast.show("success", "Task deleted");
      refetchGlobalTasks();
      navigate("");
    } else {
      toast.show("error", res.description);
    }
  }

  return (
    <div className="content-container">
      <PageHero
        title={
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span>{displayTitle}</span>
            {task.stop_reason ? (
              <Badge variant="failed" label="Stopped" />
            ) : task.scope === "live_and_backfill" ? (
              <>
                {task.backfill_status === "running" && <Badge variant="running" label="Backfilling" />}
                {task.backfill_status === "complete" && <Badge variant="complete" label="Backfill Complete" />}
                {task.live_enabled ? (
                  <Badge variant="live" label="Live Forward" />
                ) : (
                  <Badge variant="paused" label="Live Paused" />
                )}
                {task.backfill_status === "paused" && <Badge variant="paused" label="Backfill Paused" />}
              </>
            ) : task.live_enabled ? (
              <Badge variant="live" label="Live Forward" />
            ) : task.backfill_status === "running" ? (
              <Badge variant="running" label="Backfilling" />
            ) : task.backfill_status === "paused" ? (
              <Badge variant="paused" label="Paused" />
            ) : task.backfill_status === "complete" ? (
              <Badge variant="complete" label="Complete" />
            ) : task.backfill_status === "cancelled" ? (
              <Badge variant="idle" label="Cancelled" />
            ) : !task.live_enabled && task.scope === "live" ? (
              <Badge variant="paused" label="Live Paused" />
            ) : (
              <Badge variant="idle" label={task.backfill_status ?? "Idle"} />
            )}
          </div>
        }
        subtitle={`Scope: ${task.scope.replace(/_/g, " ")} · Created ${new Date(task.created_at * 1000).toLocaleString()}`}
      >
        <button className="btn btn-secondary btn-sm" onClick={() => navigate("")}>
          ← Back to Tasks
        </button>
        {task.backfill_status === "running" && (
          <button className="btn btn-secondary btn-sm" onClick={() => patch({ backfillStatus: "paused" })}>
            Pause Backfill
          </button>
        )}
        {task.backfill_status === "paused" && (
          <button className="btn btn-primary btn-sm" onClick={() => patch({ backfillStatus: "running" })}>
            Resume Backfill
          </button>
        )}
        {task.scope === "live" && task.live_enabled && (
          <button className="btn btn-secondary btn-sm" onClick={() => patch({ liveEnabled: false })}>
            Pause Live
          </button>
        )}
        {task.scope === "live" && !task.live_enabled && (
          <button className="btn btn-primary btn-sm" onClick={() => patch({ liveEnabled: true })}>
            Resume Live
          </button>
        )}
        {task.scope === "live_and_backfill" && !task.live_enabled && task.backfill_status === "paused" && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => patch({ liveEnabled: true, backfillStatus: "running" })}
          >
            Resume All
          </button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={openEditModal}>
          ✏️ Edit Task
        </button>
        <button className="btn btn-danger btn-sm" onClick={removeTask}>
          Delete
        </button>
      </PageHero>

      {task.stop_reason && (
        <div className="card">
          <PermissionErrorBanner
            reason={task.stop_reason}
            description={`Telegram rejected requests from this bot as of ${
              task.stopped_at ? new Date(task.stopped_at * 1000).toLocaleString() : "an unknown time"
            }.`}
          />
        </div>
      )}

      {/* Pipeline Execution Card (Zero Duplication) */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Pipeline Execution</div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: task.scope === "backfill_only" || task.scope === "live" ? "1fr" : "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
          {/* Section 1: Historical Backfill (if applicable) */}
          {task.scope !== "live" && (
            <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12, color: "var(--success)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>📦 Historical Backfill</span>
                <span className={`badge ${isBackfillComplete ? "badge-success" : task.backfill_status === "running" ? "badge-accent" : "badge-muted"}`} style={{ fontSize: 10, padding: "1px 6px" }}>
                  {isBackfillComplete ? "100% Complete" : task.backfill_status === "running" ? "Running" : "Paused"}
                </span>
              </div>

              {/* Progress bar */}
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  <span style={{ color: isBackfillComplete ? "var(--success)" : "var(--accent)" }}>
                    {isBackfillComplete ? "✓ Range Scanned" : `${rangeScannedPct}% Range Scanned`}
                  </span>
                  <span className="text-muted" style={{ fontFamily: "var(--font-mono)" }}>
                    {scannedCount.toLocaleString()} / {(task.total ?? 0).toLocaleString()} IDs
                  </span>
                </div>
                <div style={{ height: 6, background: "var(--surface-hover)", borderRadius: "var(--radius-full)", overflow: "hidden" }}>
                  <div
                    style={{
                      width: `${isBackfillComplete ? 100 : rangeScannedPct}%`,
                      height: "100%",
                      background: isBackfillComplete ? "var(--success)" : "var(--accent)",
                      borderRadius: "var(--radius-full)",
                      /* impeccable-disable-next-line layout-transition -- progress bar percentage */
                      transition: "width 260ms cubic-bezier(0.16, 1, 0.3, 1)",
                    }}
                  />
                </div>
              </div>

              <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.8 }}>
                <div>Range: <strong style={{ color: "var(--ink)" }}>IDs {(task.start_id ?? 1).toLocaleString()} to {(task.end_id ?? 0).toLocaleString()}</strong> {task.cursor != null ? `(cursor at #${task.cursor.toLocaleString()})` : ""}</div>
                <div>Messages Copied: <strong style={{ color: "var(--ink)" }}>{(task.processed ?? 0).toLocaleString()}</strong></div>
                {task.failed > 0 && (
                  <div style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
                    ({task.failed.toLocaleString()} empty or deleted message IDs skipped)
                  </div>
                )}
                <div>Pacing: <strong style={{ color: "var(--ink)" }}>~{task.pacing_batch_size ?? 60} msgs/batch</strong></div>
              </div>
            </div>
          )}

          {/* Section 2: Live Forwarding (if applicable) */}
          {task.scope !== "backfill_only" && (
            <div style={{ background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", padding: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12, color: "var(--info)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>⚡ Live Auto-Sync</span>
                <span className={`badge ${task.live_enabled ? "badge-accent" : "badge-muted"}`} style={{ fontSize: 10, padding: "1px 6px" }}>
                  {task.live_enabled ? "Active (1m poll)" : "Paused"}
                </span>
              </div>

              <div style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.8 }}>
                <div>Forwarded: <strong style={{ color: "var(--ink)" }}>{(task.live_processed ?? 0).toLocaleString()} messages</strong></div>
                {task.live_skipped ? (
                  <div>Filtered Out: <strong style={{ color: "var(--warning)" }}>{task.live_skipped.toLocaleString()} messages</strong></div>
                ) : null}
                {task.pending_count && task.pending_count > 0 ? (
                  <div>Live Buffer: <strong style={{ color: "var(--info)" }}>{task.pending_count.toLocaleString()} queued</strong> {task.backfill_status === "running" ? "(waiting for backfill to finish)" : ""}</div>
                ) : null}
                {task.filter_media_types || task.filter_min_size_bytes || task.filter_max_size_bytes ? (
                  <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--ink)", borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }}>
                    Filters: <strong>{task.filter_media_types ? task.filter_media_types.split(",").map((m) => getMediaIcon(m.trim())).join(", ") : "All media"}</strong>
                    {task.filter_min_size_bytes ? ` (≥ ${formatBytes(task.filter_min_size_bytes)})` : ""}
                    {task.filter_max_size_bytes ? ` (≤ ${formatBytes(task.filter_max_size_bytes)})` : ""}
                  </div>
                ) : (
                  <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--muted)", borderTop: "1px solid var(--border-subtle)", paddingTop: 8 }}>
                    Filters: <em>None (forwarding all incoming messages)</em>
                  </div>
                )}
                <div style={{ marginTop: 12 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    disabled={!!task.stop_reason}
                    onClick={() => patch({ liveEnabled: !task.live_enabled })}
                  >
                    {task.live_enabled ? "Pause Live" : "Resume Live"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Task Specification Card */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Task Specification</div>
        </div>
        <div className="task-spec-grid">
          <div className="task-spec-item">
            <div className="task-spec-label">{task.mode === "protocol" ? "Protocol Account" : "Connected Bot"}</div>
            <div className="task-spec-value">
              {task.mode === "protocol" ? (
                <span>
                  📱 {task.bot_username} <span className="badge" style={{ marginLeft: 6, fontSize: 10.5 }}>protocol</span>
                </span>
              ) : (
                <>@{task.bot_username}</>
              )}
            </div>
          </div>
          <div className="task-spec-item">
            <div className="task-spec-label">Source Chat</div>
            <div className="task-spec-value">{task.source_chat_title || "Channel"}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{task.source_chat_id}</div>
          </div>
          <div className="task-spec-item">
            <div className="task-spec-label">Destination Chat</div>
            <div className="task-spec-value">{task.dest_chat_title || "Channel"}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", fontFamily: "var(--font-mono)", marginTop: 2 }}>{task.dest_chat_id}</div>
          </div>
          <div className="task-spec-item">
            <div className="task-spec-label">Scope & Created</div>
            <div className="task-spec-value">{task.scope.replace(/_/g, " ")}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{new Date(task.created_at * 1000).toLocaleString()}</div>
          </div>
        </div>
      </div>

      {/* Recent Activity & Diagnostic Hub */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">Recent Activity</div>
        </div>
        {!activity || activity.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 13 }}>
            No activity logged yet.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontFamily: "var(--font-mono)", fontSize: 12 }}>
            {activity.map((entry) => {
              const isFiltered = entry.error?.startsWith("Filtered:") || entry.detail?.includes("skipped:");
              const isBufferQueue = entry.detail?.includes("Queued in buffer");
              return (
                <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ color: entry.ok ? "var(--success)" : isFiltered ? "var(--warning)" : "var(--danger)" }}>
                    {entry.ok ? "✓" : isFiltered ? "⊘" : "✗"}
                  </span>
                  <span className="text-muted">{new Date(entry.at * 1000).toLocaleTimeString()}</span>
                  <span
                    style={{
                      display: "inline-block",
                      padding: "1px 6px",
                      borderRadius: "3px",
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: "0.5px",
                      backgroundColor: isFiltered
                        ? "var(--warning-tint)"
                        : isBufferQueue
                        ? "var(--accent-tint)"
                        : entry.kind === "live_forward"
                        ? "var(--success-tint)"
                        : "var(--surface-hover)",
                      color: isFiltered
                        ? "var(--warning)"
                        : isBufferQueue
                        ? "var(--accent)"
                        : entry.kind === "live_forward"
                        ? "var(--success)"
                        : "var(--muted)",
                    }}
                  >
                    {isFiltered ? "FILTERED" : isBufferQueue ? "QUEUED" : entry.kind === "live_forward" ? "LIVE" : "BACKFILL"}
                  </span>
                  <span>{entry.detail}</span>
                  {entry.error && !isFiltered && <span className="text-danger">— {entry.error}</span>}
                </div>
              );
            })}
          </div>
        )}

        {/* Diagnostic Tool: Send Test Message Copy */}
        <div className="activity-diagnostic-box">
          <div className="activity-diagnostic-header">Diagnostic Tool — Send Test Message Copy</div>
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="input"
              style={{ maxWidth: 220 }}
              placeholder="Message ID (optional)"
              value={testMessageId}
              onChange={(e) => setTestMessageId(e.target.value)}
            />
            <button className="btn btn-secondary btn-sm" disabled={testingCopy} onClick={runTestCopy}>
              {testingCopy ? "Sending…" : "Send Test Copy"}
            </button>
          </div>
          {testCopyResult && (
            <p className="text-muted" style={{ fontSize: 12.5, marginTop: 8 }}>
              {testCopyResult}
            </p>
          )}
        </div>
      </div>

      {/* Edit Task Modal */}
      {isEditing && (
        <div className="modal-backdrop" onClick={() => !savingEdit && setIsEditing(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                <span>✏️ Edit Task Configuration</span>
              </div>
              <button
                className="modal-close"
                disabled={savingEdit}
                onClick={() => setIsEditing(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

            <div className="modal-body">
              {/* Task Label */}
              <div className="field">
                <label>Task Label</label>
                <input
                  className="input"
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  placeholder={displayInfo?.routeText || "Task Name / Label"}
                />
              </div>

              {/* Scope Selector */}
              <div className="field">
                <label>Copy Scope</label>
                <select
                  className="input"
                  value={editScope}
                  onChange={(e) => setEditScope(e.target.value as TaskScope)}
                >
                  <option value="live">New messages only (Live forward)</option>
                  <option value="live_and_backfill">✨ Existing + New (Catch-Up Stream)</option>
                  <option value="backfill_only">Existing only (One-time history backfill)</option>
                </select>
              </div>

              {/* Backfill Range Card */}
              {(editScope === "backfill_only" || editScope === "live_and_backfill") && (
                <div
                  style={{
                    padding: "14px 16px",
                    background: "var(--surface-raised)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: "var(--ink)" }}>
                    📦 Backfill Range Configuration
                  </div>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <div className="field" style={{ margin: 0, flex: 1 }}>
                      <label style={{ fontSize: 11 }}>Start ID</label>
                      <input
                        className="input"
                        type="number"
                        min="1"
                        value={editStartId}
                        onChange={(e) => setEditStartId(e.target.value)}
                        placeholder="Start ID"
                      />
                    </div>
                    <div className="field" style={{ margin: 0, flex: 1 }}>
                      <label style={{ fontSize: 11 }}>End ID</label>
                      <input
                        className="input"
                        type="number"
                        min="1"
                        value={editEndId}
                        onChange={(e) => setEditEndId(e.target.value)}
                        placeholder="End ID"
                      />
                    </div>
                    <div className="field" style={{ margin: 0, flex: 1 }}>
                      <label style={{ fontSize: 11 }}>Current Cursor</label>
                      <input
                        className="input"
                        type="number"
                        min="1"
                        disabled={resetProgress}
                        value={resetProgress ? editStartId : editCursor}
                        onChange={(e) => setEditCursor(e.target.value)}
                        placeholder="Cursor"
                      />
                    </div>
                  </div>

                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={resetProgress}
                      onChange={(e) => setResetProgress(e.target.checked)}
                    />
                    <span>Reset progress counters (0 copied / 0 failed) and restart from Start ID</span>
                  </label>

                  <p className="text-muted" style={{ fontSize: 11.5, marginTop: 8 }}>
                    ⚡ Bulk backfill pace: 60 messages/minute without filters to preserve complete chat history.
                  </p>
                </div>
              )}

              {/* Message Filters Card */}
              {editScope !== "backfill_only" && (
                <div
                  style={{
                    padding: "14px 16px",
                    background: "var(--surface-raised)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                      <span>🔍 {editScope === "live" ? "Live Message Filters" : "Live Stream Filters (Stage 2)"}</span>
                    </div>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer", fontWeight: 600 }}>
                      <input
                        type="checkbox"
                        checked={enableFilters}
                        onChange={(e) => setEnableFilters(e.target.checked)}
                      />
                      Enable Filters
                    </label>
                  </div>

                  {editScope === "live_and_backfill" && (
                    <div
                      style={{
                        padding: "8px 10px",
                        background: "var(--accent-tint)",
                        border: "1px solid var(--accent-border)",
                        borderRadius: "var(--radius-sm)",
                        fontSize: 11.5,
                        color: "var(--ink)",
                        lineHeight: 1.4,
                        marginBottom: 10,
                      }}
                    >
                      • <strong>Backfill</strong> copies full history at 60 msgs/min unfiltered.<br />
                      • <strong>Live stream</strong> applies the filters below once backfill completes (buffering matching messages until then).
                    </div>
                  )}

                  {enableFilters && (
                    <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 10 }}>
                      <div>
                        <label style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink)", display: "block", marginBottom: 4 }}>
                          Allowed Media Types (Leave unchecked for all media)
                        </label>
                        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
                          {[
                            { id: "document", label: "📄 Documents" },
                            { id: "video", label: "🎬 Videos" },
                            { id: "photo", label: "🖼️ Photos" },
                            { id: "audio", label: "🎵 Audio" },
                          ].map((mt) => (
                            <label key={mt.id} style={{ display: "flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={filterMediaTypes.includes(mt.id)}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    setFilterMediaTypes([...filterMediaTypes, mt.id]);
                                  } else {
                                    setFilterMediaTypes(filterMediaTypes.filter((t) => t !== mt.id));
                                  }
                                }}
                              />
                              {mt.label}
                            </label>
                          ))}
                        </div>
                      </div>

                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
                        <div className="field" style={{ margin: 0 }}>
                          <label style={{ fontSize: 11 }}>Min File Size (MB)</label>
                          <input
                            className="input"
                            type="number"
                            min="0"
                            step="1"
                            placeholder="e.g. 10 (ignore < 10 MB)"
                            value={minFileSizeMb}
                            onChange={(e) => setMinFileSizeMb(e.target.value)}
                          />
                        </div>
                        <div className="field" style={{ margin: 0 }}>
                          <label style={{ fontSize: 11 }}>Max File Size (MB, optional)</label>
                          <input
                            className="input"
                            type="number"
                            min="0"
                            step="1"
                            placeholder="e.g. 500 (ignore > 500 MB)"
                            value={maxFileSizeMb}
                            onChange={(e) => setMaxFileSizeMb(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button
                className="btn btn-secondary btn-sm"
                disabled={savingEdit}
                onClick={() => setIsEditing(false)}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={savingEdit}
                onClick={handleSaveEdit}
              >
                {savingEdit ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
