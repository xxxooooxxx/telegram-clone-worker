import { useEffect, useMemo, useState } from "react";
import { navigate, useHashRoute, type Route } from "../lib/router";
import { api, listAllTasks } from "../lib/api";
import { useLayout } from "./LayoutContext";
import { useTasks, getTaskDisplayInfo } from "../lib/useTasksContext";
import { useAuth } from "../lib/useAuth";
import { AuthPage } from "../pages/AuthPage";
import type { BotSummary, TaskSummary } from "../../shared/rpcTypes";

type Section = "tasks" | "paused" | "completed" | "add" | "bots" | "protocol" | "saved" | null;

function sectionOf(route: Route): Section {
  if (route.type === "wizard") return "add";
  if (route.type === "paused") return "paused";
  if (route.type === "completed") return "completed";
  if (route.type === "bots") return "bots";
  if (route.type === "protocol-accounts") return "protocol";
  if (route.type === "saved-tasks") return "saved";
  if (route.type === "empty") return "tasks";
  return null;
}

function ProtocolIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <line x1="11" y1="18.5" x2="13" y2="18.5" />
    </svg>
  );
}

function PausedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="10" y1="15" x2="10" y2="9" />
      <line x1="14" y1="15" x2="14" y2="9" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <polyline points="7,12.5 10.5,16 17,8.5" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function BotsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="8" width="14" height="11" rx="2" />
      <circle cx="9" cy="13.5" r="1" />
      <circle cx="15" cy="13.5" r="1" />
      <line x1="12" y1="8" x2="12" y2="4" />
      <circle cx="12" cy="3" r="1" />
    </svg>
  );
}

function SavedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="6,3 18,3 18,21 12,17 6,21" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [bots, setBots] = useState<BotSummary[] | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    (async () => {
      const [botsRes, tasksRes] = await Promise.all([api.get<BotSummary[]>("/api/bots"), listAllTasks()]);
      setBots(botsRes.ok ? botsRes.data : []);
      setTasks(tasksRes.ok ? tasksRes.data : []);
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const q = query.trim().toLowerCase();
  const filteredTasks = useMemo(
    () =>
      (tasks ?? [])
        .filter((t) => {
          if (!q) return true;
          const { title, routeText } = getTaskDisplayInfo(t);
          return (
            t.label.toLowerCase().includes(q) ||
            title.toLowerCase().includes(q) ||
            routeText.toLowerCase().includes(q)
          );
        })
        .slice(0, 6),
    [tasks, q],
  );
  const filteredBots = useMemo(
    () =>
      (bots ?? [])
        .filter((b) => !q || b.label.toLowerCase().includes(q) || b.bot_username.toLowerCase().includes(q))
        .slice(0, 6),
    [bots, q],
  );
  const nothingFound = bots !== null && tasks !== null && filteredTasks.length === 0 && filteredBots.length === 0;

  if (!open) return null;

  return (
    <div className="drawer-backdrop is-open" style={{ zIndex: "var(--z-palette, 700)" }} onClick={onClose}>
      <div
        className="card"
        style={{
          maxWidth: 480,
          width: "90%",
          margin: "12vh auto 0",
          background: "var(--surface)",
          boxShadow: "0 20px 50px rgba(0,0,0,0.7)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 12 }}>
          <SearchIcon />
          <input
            className="input"
            style={{ flex: 1 }}
            placeholder="Jump to a task or bot…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div style={{ maxHeight: 260, overflowY: "auto" }}>
          {bots === null || tasks === null ? (
            <div className="text-muted" style={{ padding: 12, textAlign: "center" }}>Loading…</div>
          ) : nothingFound ? (
            <div className="text-muted" style={{ padding: 12, textAlign: "center" }}>
              {q ? `No matches for "${query}"` : "No tasks or bots found."}
            </div>
          ) : (
            <>
              {filteredTasks.map((t) => (
                <div
                  key={t.id}
                  className="sidebar-nav-item"
                  style={{ cursor: "pointer", marginBottom: 4 }}
                  onClick={() => {
                    navigate(`task/${t.id}`);
                    onClose();
                  }}
                >
                  <div className="sidebar-nav-item-left">
                    <TasksIcon />
                    <span>{getTaskDisplayInfo(t).title}</span>
                  </div>
                  <span className={`badge-count ${t.live_enabled ? "live" : ""}`}>
                    {t.live_enabled ? "Live" : "Task"}
                  </span>
                </div>
              ))}
              {filteredBots.map((b) => (
                <div
                  key={b.id}
                  className="sidebar-nav-item"
                  style={{ cursor: "pointer", marginBottom: 4 }}
                  onClick={() => {
                    navigate("bots");
                    onClose();
                  }}
                >
                  <div className="sidebar-nav-item-left">
                    <BotsIcon />
                    <span>@{b.bot_username} ({b.label})</span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function AppNav() {
  const route = useHashRoute();
  const section = sectionOf(route);
  const { sidebarCollapsed, drawerOpen, toggleSidebar, setDrawerOpen } = useLayout();
  const { mode, source, logout } = useAuth();
  const [showSetupModal, setShowSetupModal] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { liveCount: liveTaskCount, pausedCount: pausedTaskCount, completedCount: completedTaskCount } = useTasks();

  // Keyboard shortcut Ctrl/Cmd+K for quick search
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function handleNav(target: string) {
    if (target === "tasks") navigate("");
    else navigate(target);
    setDrawerOpen(false);
  }

  return (
    <>
      {/* Backdrop for mobile off-canvas drawer */}
      <div
        className={`drawer-backdrop${drawerOpen ? " is-open" : ""}`}
        onClick={() => setDrawerOpen(false)}
      />

      {/* Retractable Sidebar (Desktop Collapsible + Mobile Off-Canvas Drawer) */}
      <aside
        className={`app-sidebar${sidebarCollapsed ? " is-collapsed" : ""}${drawerOpen ? " drawer-open" : ""}`}
        aria-label="Navigation sidebar"
      >
        <div className="sidebar-brand">
          <div
            className="sidebar-brand-left"
            onClick={() => handleNav("tasks")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleNav("tasks");
              }
            }}
            title="Go to main page"
          >
            <div className="sidebar-brand-mark" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </div>
            <div className="sidebar-brand-name">
              Telegram Clone Worker
            </div>
          </div>
          <button
            className="btn-sidebar-toggle"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <CollapseIcon />
          </button>
        </div>

        <nav className="sidebar-nav">
          <div className="sidebar-category-header">Tasks</div>
          <button
            className={`sidebar-nav-item${section === "tasks" ? " is-active" : ""}`}
            onClick={() => handleNav("tasks")}
          >
            <div className="sidebar-nav-item-left">
              <TasksIcon />
              <span>Active Tasks</span>
            </div>
            {liveTaskCount > 0 && <span className="badge-count live">{liveTaskCount} Live</span>}
          </button>
          <button
            className={`sidebar-nav-item${section === "paused" ? " is-active" : ""}`}
            onClick={() => handleNav("paused")}
          >
            <div className="sidebar-nav-item-left">
              <PausedIcon />
              <span>Paused Tasks</span>
            </div>
            {pausedTaskCount > 0 && <span className="badge-count paused">{pausedTaskCount}</span>}
          </button>
          <button
            className={`sidebar-nav-item${section === "completed" ? " is-active" : ""}`}
            onClick={() => handleNav("completed")}
          >
            <div className="sidebar-nav-item-left">
              <HistoryIcon />
              <span>Completed Tasks</span>
            </div>
            {completedTaskCount > 0 && <span className="badge-count">{completedTaskCount}</span>}
          </button>

          <div className="sidebar-category-header">Management</div>
          <button
            className={`sidebar-nav-item${section === "bots" ? " is-active" : ""}`}
            onClick={() => handleNav("bots")}
          >
            <div className="sidebar-nav-item-left">
              <BotsIcon />
              <span>Connected Bots</span>
            </div>
          </button>

          <button
            className={`sidebar-nav-item${section === "protocol" ? " is-active" : ""}`}
            onClick={() => handleNav("protocol-accounts")}
          >
            <div className="sidebar-nav-item-left">
              <ProtocolIcon />
              <span>Protocol Accounts</span>
            </div>
          </button>

          <button
            className={`sidebar-nav-item${section === "saved" ? " is-active" : ""}`}
            onClick={() => handleNav("saved-tasks")}
          >
            <div className="sidebar-nav-item-left">
              <SavedIcon />
              <span>Saved Templates</span>
            </div>
          </button>

          {/* Sidebar Credits Card (Positioned directly below Saved Templates on mobile drawer) */}
          <div className="sidebar-credits-card">
            <div className="sidebar-credits-meta">
              <span className="sidebar-credits-meta-label">Author</span>
              <a
                className="sidebar-credits-author-link"
                href="https://github.com/iamLiquidX"
                target="_blank"
                rel="noopener noreferrer"
                title="iamLiquidX on GitHub"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
                <span>iamLiquidX</span>
              </a>
            </div>

            <div className="sidebar-credits-actions">
              <a
                className="sidebar-credits-btn sidebar-credits-btn-tg"
                href="https://t.me/liquidxprojects"
                target="_blank"
                rel="noopener noreferrer"
                title="Support Chat on Telegram"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z" />
                </svg>
                <span>Support Chat</span>
              </a>

              <a
                className="sidebar-credits-btn sidebar-credits-btn-gh"
                href="https://github.com/iamLiquidX/telegram-clone-worker"
                target="_blank"
                rel="noopener noreferrer"
                title="View Source on GitHub"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
                <span>Source</span>
              </a>
            </div>
          </div>

          {/* Authentication Status & Actions */}
          <div className="sidebar-auth-card">
            <div className="sidebar-auth-row">
              <div className={`sidebar-auth-status ${mode === "enforced" ? "is-locked" : "is-open"}`}>
                {mode === "enforced" ? (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <span>{source === "env" ? "Env Secured" : "Secured"}</span>
                  </>
                ) : (
                  <>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                    <span>Unprotected</span>
                  </>
                )}
              </div>

              {mode === "enforced" ? (
                <button
                  type="button"
                  className="sidebar-auth-btn"
                  onClick={() => logout()}
                  title="Log out from admin console"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  <span>Log Out</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="sidebar-auth-btn"
                  onClick={() => setShowSetupModal(true)}
                  title="Protect console with password"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                  <span>Protect</span>
                </button>
              )}
            </div>
          </div>
        </nav>
      </aside>

      {/* Mobile Bottom Navigation Bar (Clean 56px Bar) */}
      <nav className="mobile-tabbar" aria-label="Mobile Navigation">
        <button
          className={`mobile-tab${section === "tasks" ? " active" : ""}`}
          onClick={() => handleNav("tasks")}
        >
          <TasksIcon />
          <span>Active</span>
        </button>
        <button
          className="mobile-fab"
          onClick={() => handleNav("wizard")}
          aria-label="Create new task"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          className={`mobile-tab${section === "completed" ? " active" : ""}`}
          onClick={() => handleNav("completed")}
        >
          <HistoryIcon />
          <span>History</span>
        </button>
      </nav>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {showSetupModal && (
        <AuthPage mode="setup" onCancel={() => setShowSetupModal(false)} />
      )}
    </>
  );
}
