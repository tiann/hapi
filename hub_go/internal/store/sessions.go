package store

import (
	"database/sql"
	"encoding/json"
	"time"
)

type Session struct {
	ID                   string
	Namespace            string
	Seq                  int64
	CreatedAt            int64
	UpdatedAt            int64
	Active               bool
	ActiveAt             int64
	Metadata             map[string]any
	MetadataVersion      int64
	AgentState           any
	AgentStateVersion    int64
	Todos                any
	TodosUpdatedAt       int64
	PermissionMode       string
	ModelMode            string
	Thinking             bool
	ThinkingAt           int64
	TodoProgress         any
	PendingRequestsCount int
	Tag                  string
}

type UpdateResult[T any] struct {
	Result  string
	Version int64
	Value   T
}

func (s *Store) ListSessions(namespace string) []Session {
	rows, err := s.DB.Query(
		`SELECT id, namespace, seq, created_at, updated_at, active, active_at, metadata, metadata_version, agent_state, agent_state_version, todos, todos_updated_at, permission_mode, model_mode, thinking, thinking_at, tag
         FROM sessions WHERE namespace = ? ORDER BY updated_at DESC`,
		namespace,
	)
	if err != nil {
		return []Session{}
	}
	defer rows.Close()

	var sessions []Session
	for rows.Next() {
		var session Session
		var activeInt int
		var thinkingInt int
		var metadataRaw sql.NullString
		var agentStateRaw sql.NullString
		var todosRaw sql.NullString
		var todosUpdatedAt sql.NullInt64
		var permissionMode sql.NullString
		var modelMode sql.NullString
		var tag sql.NullString
		if err := rows.Scan(
			&session.ID,
			&session.Namespace,
			&session.Seq,
			&session.CreatedAt,
			&session.UpdatedAt,
			&activeInt,
			&session.ActiveAt,
			&metadataRaw,
			&session.MetadataVersion,
			&agentStateRaw,
			&session.AgentStateVersion,
			&todosRaw,
			&todosUpdatedAt,
			&permissionMode,
			&modelMode,
			&thinkingInt,
			&session.ThinkingAt,
			&tag,
		); err != nil {
			continue
		}
		session.Active = activeInt == 1
		session.Thinking = thinkingInt == 1
		session.Metadata = decodeJSONMap(metadataRaw)
		session.AgentState = decodeJSONValue(agentStateRaw)
		session.Todos = decodeJSONValue(todosRaw)
		if todosUpdatedAt.Valid {
			session.TodosUpdatedAt = todosUpdatedAt.Int64
		}
		if permissionMode.Valid {
			session.PermissionMode = permissionMode.String
		}
		if modelMode.Valid {
			session.ModelMode = modelMode.String
		}
		if tag.Valid {
			session.Tag = tag.String
		}
		sessions = append(sessions, session)
	}
	return sessions
}

func (s *Store) GetSession(namespace string, id string) (*Session, error) {
	row := s.DB.QueryRow(
		`SELECT id, namespace, seq, created_at, updated_at, active, active_at, metadata, metadata_version, agent_state, agent_state_version, todos, todos_updated_at, permission_mode, model_mode, thinking, thinking_at, tag
         FROM sessions WHERE id = ? AND namespace = ? LIMIT 1`,
		id,
		namespace,
	)

	var session Session
	var activeInt int
	var thinkingInt int
	var metadataRaw sql.NullString
	var agentStateRaw sql.NullString
	var todosRaw sql.NullString
	var todosUpdatedAt sql.NullInt64
	var permissionMode sql.NullString
	var modelMode sql.NullString
	var tag sql.NullString
	if err := row.Scan(
		&session.ID,
		&session.Namespace,
		&session.Seq,
		&session.CreatedAt,
		&session.UpdatedAt,
		&activeInt,
		&session.ActiveAt,
		&metadataRaw,
		&session.MetadataVersion,
		&agentStateRaw,
		&session.AgentStateVersion,
		&todosRaw,
		&todosUpdatedAt,
		&permissionMode,
		&modelMode,
		&thinkingInt,
		&session.ThinkingAt,
		&tag,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	if tag.Valid {
		session.Tag = tag.String
	}
	session.Active = activeInt == 1
	session.Thinking = thinkingInt == 1
	session.Metadata = decodeJSONMap(metadataRaw)
	session.AgentState = decodeJSONValue(agentStateRaw)
	session.Todos = decodeJSONValue(todosRaw)
	if todosUpdatedAt.Valid {
		session.TodosUpdatedAt = todosUpdatedAt.Int64
	}
	if permissionMode.Valid {
		session.PermissionMode = permissionMode.String
	}
	if modelMode.Valid {
		session.ModelMode = modelMode.String
	}
	return &session, nil
}

func (s *Store) SessionExists(id string) bool {
	row := s.DB.QueryRow("SELECT 1 FROM sessions WHERE id = ? LIMIT 1", id)
	var value int
	if err := row.Scan(&value); err != nil {
		return false
	}
	return value == 1
}

func (s *Store) CreateSession(namespace string, metadata map[string]any, agentState any) (*Session, error) {
	return s.CreateSessionWithID(namespace, newUUID(), metadata, agentState)
}

func (s *Store) CreateSessionWithID(namespace string, id string, metadata map[string]any, agentState any) (*Session, error) {
	if id == "" {
		id = newUUID()
	}
	now := time.Now().UnixMilli()
	metadataRaw, _ := json.Marshal(metadata)
	agentStateRaw, _ := json.Marshal(agentState)
	_, err := s.DB.Exec(
		`INSERT OR REPLACE INTO sessions (
            id, namespace, seq, created_at, updated_at, active, active_at, metadata, metadata_version, agent_state, agent_state_version, todos, todos_updated_at, permission_mode, model_mode, thinking, thinking_at, tag
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id,
		namespace,
		0,
		now,
		now,
		0,
		now,
		string(metadataRaw),
		1,
		string(agentStateRaw),
		1,
		nil,
		nil,
		nil,
		nil,
		0,
		0,
		"",
	)
	if err != nil {
		return nil, err
	}
	return s.GetSession(namespace, id)
}

func (s *Store) UpdateSession(namespace string, session *Session) error {
	if session == nil {
		return nil
	}
	metadataRaw, _ := json.Marshal(session.Metadata)
	agentStateRaw, _ := json.Marshal(session.AgentState)
	todosRaw, _ := json.Marshal(session.Todos)
	active := 0
	if session.Active {
		active = 1
	}
	thinking := 0
	if session.Thinking {
		thinking = 1
	}
	_, err := s.DB.Exec(
		`UPDATE sessions SET
            seq = ?, updated_at = ?, active = ?, active_at = ?, metadata = ?, metadata_version = ?, agent_state = ?, agent_state_version = ?, todos = ?, todos_updated_at = ?, permission_mode = ?, model_mode = ?, thinking = ?, thinking_at = ?, tag = ?
         WHERE id = ? AND namespace = ?`,
		session.Seq,
		session.UpdatedAt,
		active,
		session.ActiveAt,
		string(metadataRaw),
		session.MetadataVersion,
		string(agentStateRaw),
		session.AgentStateVersion,
		string(todosRaw),
		nullInt64(session.TodosUpdatedAt),
		nullString(session.PermissionMode),
		nullString(session.ModelMode),
		thinking,
		session.ThinkingAt,
		session.Tag,
		session.ID,
		namespace,
	)
	return err
}

func (s *Store) UpdateSessionMetadata(namespace string, id string, metadata map[string]any, expectedVersion int64) (UpdateResult[map[string]any], error) {
	session, err := s.GetSession(namespace, id)
	if err != nil {
		return UpdateResult[map[string]any]{Result: "error"}, err
	}
	if session == nil {
		return UpdateResult[map[string]any]{Result: "error"}, nil
	}
	if expectedVersion != session.MetadataVersion {
		return UpdateResult[map[string]any]{Result: "version-mismatch", Version: session.MetadataVersion, Value: session.Metadata}, nil
	}

	session.MetadataVersion++
	session.Metadata = metadata
	session.UpdatedAt = time.Now().UnixMilli()
	if err := s.UpdateSession(namespace, session); err != nil {
		return UpdateResult[map[string]any]{Result: "error"}, err
	}
	return UpdateResult[map[string]any]{Result: "success", Version: session.MetadataVersion, Value: session.Metadata}, nil
}

func (s *Store) UpdateSessionAgentState(namespace string, id string, agentState any, expectedVersion int64) (UpdateResult[any], error) {
	session, err := s.GetSession(namespace, id)
	if err != nil {
		return UpdateResult[any]{Result: "error"}, err
	}
	if session == nil {
		return UpdateResult[any]{Result: "error"}, nil
	}
	if expectedVersion != session.AgentStateVersion {
		return UpdateResult[any]{Result: "version-mismatch", Version: session.AgentStateVersion, Value: session.AgentState}, nil
	}

	session.AgentStateVersion++
	session.AgentState = agentState
	session.UpdatedAt = time.Now().UnixMilli()
	if err := s.UpdateSession(namespace, session); err != nil {
		return UpdateResult[any]{Result: "error"}, err
	}
	return UpdateResult[any]{Result: "success", Version: session.AgentStateVersion, Value: session.AgentState}, nil
}

func (s *Store) SetSessionTodos(namespace string, id string, todos any, todosUpdatedAt int64) bool {
	session, err := s.GetSession(namespace, id)
	if err != nil || session == nil {
		return false
	}
	if session.TodosUpdatedAt != 0 && session.TodosUpdatedAt >= todosUpdatedAt {
		return false
	}
	session.Todos = todos
	session.TodosUpdatedAt = todosUpdatedAt
	session.UpdatedAt = todosUpdatedAt
	if err := s.UpdateSession(namespace, session); err != nil {
		return false
	}
	return true
}

func (s *Store) DeleteSession(namespace string, id string) bool {
	result, err := s.DB.Exec("DELETE FROM sessions WHERE id = ? AND namespace = ?", id, namespace)
	if err != nil {
		return false
	}
	rows, _ := result.RowsAffected()
	return rows > 0
}

func decodeJSONMap(raw sql.NullString) map[string]any {
	if !raw.Valid || raw.String == "" {
		return nil
	}
	var value map[string]any
	if err := json.Unmarshal([]byte(raw.String), &value); err != nil {
		return nil
	}
	return value
}

func decodeJSONValue(raw sql.NullString) any {
	if !raw.Valid || raw.String == "" {
		return nil
	}
	var value any
	if err := json.Unmarshal([]byte(raw.String), &value); err != nil {
		return nil
	}
	return value
}

func nullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nullInt64(value int64) any {
	if value == 0 {
		return nil
	}
	return value
}
