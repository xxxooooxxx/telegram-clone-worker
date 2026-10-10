import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { usePolling } from "../lib/usePolling";
import { useToast } from "../components/Toast";
import { PageHero } from "../components/PageHero";
import type { BridgeConfigResponse, ProtocolAccountSummary, TaskSummary } from "../../shared/rpcTypes";

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "authorized"
      ? "var(--success)"
      : status === "unauthorized" || status === "not_found"
        ? "var(--danger)"
        : "var(--muted)";
  return (
    <span className="badge" style={{ borderColor: `color-mix(in oklab, ${color} 40%, transparent)` }}>
      <span style={{ color, fontWeight: 700 }}>●</span> {status}
    </span>
  );
}

function LoginCard({ account, onDone }: { account: ProtocolAccountSummary; onDone: () => void }) {
  const toast = useToast();
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [needs2fa, setNeeds2fa] = useState(false);
  const [busy, setBusy] = useState(false);

  async function sendCode() {
    if (!apiId.trim() || !apiHash.trim()) {
      toast.show("error", "api_id and api_hash are required");
      return;
    }
    setBusy(true);
    const res = await api.post<{ already_authorized: boolean }>(
      `/api/protocol-accounts/${account.id}/send-code`,
      { api_id: apiId.trim(), api_hash: apiHash.trim() },
    );
    setBusy(false);
    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }
    if (res.data.already_authorized) {
      toast.show("success", "Already logged in");
      onDone();
      return;
    }
    setCodeSent(true);
    toast.show("success", "Code sent — check Telegram on that number");
  }

  async function confirm() {
    if (!code.trim()) {
      toast.show("error", "Enter the code from Telegram");
      return;
    }
    setBusy(true);
    const res = await api.post(`/api/protocol-accounts/${account.id}/confirm`, {
      api_id: apiId.trim(),
      api_hash: apiHash.trim(),
      code: code.trim(),
      password: password || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      if (res.description.toLowerCase().includes("two-factor")) setNeeds2fa(true);
      toast.show("error", res.description);
      return;
    }
    toast.show("success", "Logged in");
    setCodeSent(false);
    setNeeds2fa(false);
    setCode("");
    setPassword("");
    onDone();
  }

  return (
    <div
      style={{
        marginTop: 10,
        padding: "12px 14px",
        background: "var(--surface-raised)",
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 13 }}>Log in {account.phone}</div>
      {!codeSent ? (
        <>
          <div className="row">
            <input className="input" style={{ maxWidth: 160 }} placeholder="api_id" value={apiId} onChange={(e) => setApiId(e.target.value)} />
            <input
              className="input"
              style={{ flex: 1, minWidth: 200 }}
              placeholder="api_hash"
              type="password"
              value={apiHash}
              onChange={(e) => setApiHash(e.target.value)}
            />
          </div>
          <p className="text-muted" style={{ fontSize: 11.5, margin: 0 }}>
            From <a href="https://my.telegram.org" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>my.telegram.org ↗</a>.
            They are only passed through to the bridge for this login — never stored in the Worker database.
          </p>
          <div>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={sendCode}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <input className="input" style={{ maxWidth: 200 }} placeholder="Code from Telegram" value={code} onChange={(e) => setCode(e.target.value)} />
            {needs2fa && (
              <input className="input" style={{ maxWidth: 200 }} placeholder="2FA password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            )}
          </div>
          <div className="row">
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={confirm}>
              {busy ? "Confirming…" : "Confirm login"}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => { setCodeSent(false); setNeeds2fa(false); }}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ProtocolAccountsPage() {
  const toast = useToast();
  const { data: accounts, refetch: refetchAccounts } = usePolling(
    () => api.get<ProtocolAccountSummary[]>("/api/protocol-accounts"),
    30000,
  );
  const [label, setLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [bridgeSecret, setBridgeSecret] = useState("");
  const [bridgeSaved, setBridgeSaved] = useState<BridgeConfigResponse | null>(null);
  const [savingBridge, setSavingBridge] = useState(false);
  const [loginFor, setLoginFor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function loadBridge() {
    const res = await api.get<BridgeConfigResponse>("/api/bridge/config");
    if (res.ok) {
      setBridgeSaved(res.data);
      if (res.data.url) setBridgeUrl(res.data.url);
    }
  }

  useEffect(() => {
    loadBridge();
  }, []);

  async function saveBridge() {
    if (!bridgeUrl.trim()) {
      toast.show("error", "Bridge URL is required");
      return;
    }
    setSavingBridge(true);
    const res = await api.post<BridgeConfigResponse>("/api/bridge/config", {
      url: bridgeUrl.trim(),
      secret: bridgeSecret || undefined,
    });
    setSavingBridge(false);
    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }
    setBridgeSaved(res.data);
    setBridgeSecret("");
    toast.show("success", "Bridge config saved");
  }

  async function addAccount() {
    if (!phone.trim()) {
      toast.show("error", "Phone number is required");
      return;
    }
    setAdding(true);
    const res = await api.post<ProtocolAccountSummary>("/api/protocol-accounts", {
      label: label.trim(),
      phone: phone.trim(),
    });
    setAdding(false);
    if (!res.ok) {
      toast.show("error", res.description);
      return;
    }
    setLabel("");
    setPhone("");
    toast.show("success", "Account added — send a login code to activate it");
    refetchAccounts();
  }

  async function verify(id: string) {
    setBusyId(id);
    const res = await api.post<ProtocolAccountSummary>(`/api/protocol-accounts/${id}/verify`);
    setBusyId(null);
    if (!res.ok) toast.show("error", res.description);
    else toast.show("success", `Status: ${res.data.status}`);
    refetchAccounts();
  }

  async function remove(id: string, accLabel: string) {
    if (!confirm(`Delete protocol account "${accLabel}"? Its session on the bridge will be logged out too.`)) return;
    const res = await api.del(`/api/protocol-accounts/${id}`);
    if (!res.ok) toast.show("error", res.description);
    else {
      toast.show("success", "Account deleted");
      refetchAccounts();
    }
  }

  const { data: allTasks } = usePolling(() => api.get<TaskSummary[]>("/api/tasks"), 15000);
  const activeProtocolTasks = (allTasks ?? []).filter(
    (t) => t.mode === "protocol" && (t.live_enabled || t.backfill_status === "running" || t.backfill_status === "paused"),
  );

  return (
    <div className="content-container">
      <PageHero
        title="Protocol Accounts"
        subtitle="MTProto user accounts for protocol-mode cloning — sessions live on the bridge host, never in the Worker"
      />

      {/* Bridge connection */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <div className="card-title">🌉 Bridge Connection</div>
          {bridgeSaved?.configured && <span className="badge badge-live">Configured</span>}
        </div>
        <div className="field">
          <label>Bridge URL</label>
          <div className="row">
            <input
              className="input"
              style={{ flex: 1 }}
              value={bridgeUrl}
              onChange={(e) => setBridgeUrl(e.target.value)}
              placeholder="http://<bridge-host>:18787"
            />
          </div>
        </div>
        <div className="field">
          <label>Bridge Secret {bridgeSaved?.configured && <span className="text-muted">(leave empty to keep current)</span>}</label>
          <input
            className="input"
            type="password"
            value={bridgeSecret}
            onChange={(e) => setBridgeSecret(e.target.value)}
            placeholder="X-Bridge-Secret value from the bridge host"
          />
        </div>
        <button className="btn btn-primary btn-sm" disabled={savingBridge} onClick={saveBridge}>
          {savingBridge ? "Saving…" : "Save Bridge Config"}
        </button>
      </div>

      {/* Add account */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <div className="card-title">➕ Add Protocol Account</div>
        </div>
        <div className="row">
          <input className="input" style={{ maxWidth: 220 }} placeholder="Label (e.g. main)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className="input" style={{ maxWidth: 220 }} placeholder="Phone (+8613800000000)" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="btn btn-primary btn-sm" disabled={adding} onClick={addAccount}>
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      </div>

      {/* Account list */}
      <div className="card">
        <div className="card-header">
          <div className="card-title">📱 Accounts ({accounts?.length ?? 0})</div>
        </div>
        {!accounts ? (
          <div className="skeleton-row" style={{ height: 36 }} />
        ) : accounts.length === 0 ? (
          <p className="text-muted" style={{ fontSize: 13 }}>No protocol accounts yet. Add one above, then send it a login code.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {accounts.map((a) => {
              const taskCount = activeProtocolTasks.filter((t) => t.protocol_account_id === a.id).length;
              return (
                <div
                  key={a.id}
                  style={{
                    padding: "12px 14px",
                    background: "var(--surface-raised)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>
                        {a.label} <span className="text-muted" style={{ fontWeight: 400, fontSize: 12.5 }}>{a.phone}</span>
                      </div>
                      <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center" }}>
                        <StatusBadge status={a.status} />
                        {taskCount > 0 && <span className="badge badge-live" style={{ fontSize: 11 }}>{taskCount} active</span>}
                      </div>
                    </div>
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn btn-secondary btn-sm" disabled={busyId === a.id} onClick={() => verify(a.id)}>
                        {busyId === a.id ? "Checking…" : "Verify"}
                      </button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setLoginFor(loginFor === a.id ? null : a.id)}>
                        {loginFor === a.id ? "Hide login" : "Send code"}
                      </button>
                      <button className="btn btn-danger btn-sm" onClick={() => remove(a.id, a.label)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  {loginFor === a.id && <LoginCard account={a} onDone={() => { setLoginFor(null); refetchAccounts(); }} />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
