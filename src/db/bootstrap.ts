/**
 * Automatic D1 Database Bootstrap Helper
 *
 * Ensures that whenever the application is deployed (such as via the 1-Click
 * "Deploy to Cloudflare Workers" button), the database tables and indexes are
 * created automatically without requiring manual terminal migrations.
 */

let bootstrapDone = false;

export async function ensureDatabaseBootstrap(db: D1Database): Promise<void> {
  if (bootstrapDone) return;

  try {
    // Ensure app_settings table always exists
    await db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`).run();

    const existing = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'")
      .first<{ name: string }>();

    if (existing) {
      // Existing database: idempotent migration for protocol-account support.
      await db.prepare(`CREATE TABLE IF NOT EXISTS protocol_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        phone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`).run();
      const cols = await db.prepare(`PRAGMA table_info(tasks)`).all<{ name: string }>();
      const names = new Set((cols.results ?? []).map((c) => c.name));
      if (!names.has("mode")) {
        await db.prepare(`ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'bot'`).run();
      }
      if (!names.has("protocol_account_id")) {
        await db.prepare(`ALTER TABLE tasks ADD COLUMN protocol_account_id TEXT`).run();
      }
      bootstrapDone = true;
      return;
    }

    // New or uninitialized database: provision all tables and indexes in a single atomic batch
    await db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        bot_id INTEGER NOT NULL,
        bot_username TEXT NOT NULL,
        label TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_update_id INTEGER NOT NULL DEFAULT 0
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'bot' CHECK(mode IN ('bot', 'protocol')),
        protocol_account_id TEXT REFERENCES protocol_accounts(id) ON DELETE SET NULL,
        label TEXT NOT NULL,
        source_chat_id TEXT NOT NULL,
        source_chat_title TEXT,
        dest_chat_id TEXT NOT NULL,
        dest_chat_title TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('live', 'live_and_backfill', 'backfill_only')),
        live_enabled INTEGER NOT NULL DEFAULT 0,
        backfill_mode TEXT CHECK (backfill_mode IN ('range', 'lastN')),
        start_id INTEGER,
        end_id INTEGER,
        cursor INTEGER,
        total INTEGER,
        processed INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        backfill_status TEXT NOT NULL DEFAULT 'not_applicable'
          CHECK (backfill_status IN ('not_applicable', 'pending', 'running', 'paused', 'complete', 'cancelled', 'failed')),
        pacing_batch_size INTEGER NOT NULL DEFAULT 20,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        stop_reason TEXT,
        stopped_at INTEGER,
        lease_expires_at INTEGER,
        rate_limited_until INTEGER,
        live_processed INTEGER NOT NULL DEFAULT 0,
        live_failed INTEGER NOT NULL DEFAULT 0,
        filter_media_types TEXT,
        filter_min_size_bytes INTEGER,
        filter_max_size_bytes INTEGER,
        live_skipped INTEGER NOT NULL DEFAULT 0
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS task_activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('live_forward', 'backfill_batch')),
        detail TEXT,
        ok INTEGER NOT NULL,
        error TEXT,
        at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS saved_tasks (
        id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        bot_token TEXT NOT NULL,
        bot_label TEXT NOT NULL,
        bot_username TEXT NOT NULL,
        source_chat_id TEXT NOT NULL,
        source_chat_title TEXT,
        dest_chat_id TEXT NOT NULL,
        dest_chat_title TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('live', 'live_and_backfill', 'backfill_only')),
        backfill_mode TEXT CHECK (backfill_mode IN ('range', 'lastN')),
        start_id INTEGER,
        end_id INTEGER,
        n INTEGER,
        pacing_batch_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        filter_media_types TEXT,
        filter_min_size_bytes INTEGER,
        filter_max_size_bytes INTEGER
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS task_pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        media_type TEXT,
        file_size INTEGER,
        file_name TEXT
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
        update_id INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        received_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS protocol_accounts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        phone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_bot_id ON tasks(bot_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_source_chat ON tasks(bot_id, source_chat_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_tasks_backfill_running ON tasks(backfill_status) WHERE backfill_status = 'running'`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_task_activity_log_task_id ON task_activity_log(task_id, at DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_saved_tasks_task_id ON saved_tasks(task_id)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_messages_task_id ON task_pending_messages(task_id, id ASC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_updates_bot_id ON updates(bot_id, received_at DESC)`),
    ]);

    bootstrapDone = true;
  } catch (err) {
    console.error("Database bootstrap initialization check failed:", err);
  }
}
