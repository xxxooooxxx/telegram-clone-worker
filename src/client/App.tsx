import { useState, useEffect } from "react";
import { ToastProvider } from "./components/Toast";
import { LayoutContext } from "./components/LayoutContext";
import { TasksProvider } from "./lib/useTasksContext";
import { AuthProvider, useAuth } from "./lib/useAuth";
import { AuthPage } from "./pages/AuthPage";
import { AppNav } from "./components/AppNav";
import { AppFooter } from "./components/AppFooter";
import { useHashRoute } from "./lib/router";
import { TaskWizardPage } from "./pages/TaskWizardPage";
import { TaskDetailPage } from "./pages/TaskDetailPage";
import { BotsManagePage } from "./pages/BotsManagePage";
import { ProtocolAccountsPage } from "./pages/ProtocolAccountsPage";
import { SavedTasksPage } from "./pages/SavedTasksPage";
import { CompletedTasksPage } from "./pages/CompletedTasksPage";
import { PausedTasksPage } from "./pages/PausedTasksPage";
import { EmptyStatePage } from "./pages/EmptyStatePage";
import { ErrorBoundary } from "./components/ErrorBoundary";

function Page() {
  const route = useHashRoute();
  if (route.type === "wizard") return <TaskWizardPage fromSavedId={route.fromSavedId} />;
  if (route.type === "task") return <TaskDetailPage taskId={route.taskId} />;
  if (route.type === "paused") return <PausedTasksPage />;
  if (route.type === "completed") return <CompletedTasksPage />;
  if (route.type === "bots") return <BotsManagePage />;
  if (route.type === "protocol-accounts") return <ProtocolAccountsPage />;
  if (route.type === "saved-tasks") return <SavedTasksPage />;
  return <EmptyStatePage />;
}

function MainShell() {
  const { mode, authenticated, loading, skippedSetup } = useAuth();
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return (
        localStorage.getItem("telegram_sidebar_collapsed") === "true" ||
        localStorage.getItem("tg_sidebar_collapsed") === "true"
      );
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem("telegram_sidebar_collapsed", String(sidebarCollapsed));
    } catch {
      // ignore
    }
  }, [sidebarCollapsed]);

  const toggleSidebar = () => setSidebarCollapsed((c) => !c);

  if (loading) {
    return (
      <div className="auth-overlay">
        <div className="auth-card" style={{ textAlign: "center", padding: "40px 24px" }}>
          <div className="auth-brand-mark" style={{ margin: "0 auto 16px" }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </div>
          <div style={{ color: "var(--muted)", fontSize: "13px" }}>Loading console...</div>
        </div>
      </div>
    );
  }

  // If password is required and user is not authenticated: render login
  if (mode === "enforced" && !authenticated) {
    return <AuthPage mode="login" />;
  }

  // If in open mode and user has never chosen to skip setup: render setup
  if (mode === "open" && !skippedSetup) {
    return <AuthPage mode="setup" />;
  }

  return (
    <TasksProvider>
      <LayoutContext.Provider
        value={{
          sidebarCollapsed,
          drawerOpen,
          toggleSidebar,
          setDrawerOpen,
        }}
      >
        <div className="app-shell">
          <AppNav />
          <div className="main-layout">
            <main className="main-panel">
              <ErrorBoundary>
                <Page />
              </ErrorBoundary>
            </main>
            <AppFooter />
          </div>
        </div>
      </LayoutContext.Provider>
    </TasksProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <MainShell />
      </AuthProvider>
    </ToastProvider>
  );
}
