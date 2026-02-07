package store

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type ensureColumnKey struct {
	table  string
	column string
}

var ensureColumnPragmaByTable = map[string]string{
	"sessions": "PRAGMA table_info(sessions)",
}

var ensureColumnAlterByTableColumn = map[ensureColumnKey]string{
	{table: "sessions", column: "todos"}:            "ALTER TABLE sessions ADD COLUMN todos TEXT",
	{table: "sessions", column: "todos_updated_at"}: "ALTER TABLE sessions ADD COLUMN todos_updated_at INTEGER",
	{table: "sessions", column: "permission_mode"}:  "ALTER TABLE sessions ADD COLUMN permission_mode TEXT",
	{table: "sessions", column: "model_mode"}:       "ALTER TABLE sessions ADD COLUMN model_mode TEXT",
}

type Store struct {
	DB *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}

	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err := ensureSchema(db); err != nil {
		_ = db.Close()
		return nil, err
	}

	return &Store{DB: db}, nil
}

func (s *Store) Close() error {
	if s == nil || s.DB == nil {
		return nil
	}
	return s.DB.Close()
}

func ensureSchema(db *sql.DB) error {
	_, err := db.Exec(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'default',
            seq INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            agent_state TEXT,
            agent_state_version INTEGER DEFAULT 1,
            todos TEXT,
            todos_updated_at INTEGER,
            permission_mode TEXT,
            model_mode TEXT,
            thinking INTEGER DEFAULT 0,
            thinking_at INTEGER DEFAULT 0,
            tag TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_namespace ON sessions(namespace);
        CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(active);
        CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);

        CREATE TABLE IF NOT EXISTS machines (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            metadata TEXT,
            metadata_version INTEGER DEFAULT 1,
            runner_state TEXT,
            runner_state_version INTEGER DEFAULT 1,
            active INTEGER DEFAULT 0,
            active_at INTEGER,
            seq INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            local_id TEXT,
            FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL,
            platform_user_id TEXT NOT NULL,
            namespace TEXT NOT NULL DEFAULT 'default',
            created_at INTEGER NOT NULL,
            UNIQUE(platform, platform_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
        CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(namespace, endpoint)
        );
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);
    `)
	if err != nil {
		return err
	}

	if err := ensureColumn(db, "sessions", "todos"); err != nil {
		return err
	}
	if err := ensureColumn(db, "sessions", "todos_updated_at"); err != nil {
		return err
	}
	if err := ensureColumn(db, "sessions", "permission_mode"); err != nil {
		return err
	}
	if err := ensureColumn(db, "sessions", "model_mode"); err != nil {
		return err
	}

	return nil
}

func ensureColumn(db *sql.DB, table string, column string) error {
	pragmaSQL, ok := ensureColumnPragmaByTable[table]
	if !ok {
		return fmt.Errorf("unexpected table name: %q", table)
	}
	alterSQL, ok := ensureColumnAlterByTableColumn[ensureColumnKey{table: table, column: column}]
	if !ok {
		return fmt.Errorf("unexpected column name: %q for table %q", column, table)
	}

	rows, err := db.Query(pragmaSQL)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var ctype string
		var notnull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}

	_, err = db.Exec(alterSQL)
	return err
}
