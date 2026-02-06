package store

import (
	"database/sql"
	"encoding/json"
	"time"
)

type Message struct {
	ID        string
	SessionID string
	Content   any
	CreatedAt int64
	Seq       int64
	LocalID   string
}

func (s *Store) ListMessages(sessionID string, beforeSeq int64, limit int) []Message {
	query := `SELECT id, session_id, content, created_at, seq, local_id
        FROM messages WHERE session_id = ?`
	args := []any{sessionID}

	if beforeSeq > 0 {
		query += " AND seq < ?"
		args = append(args, beforeSeq)
	}
	query += " ORDER BY seq DESC"
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}

	rows, err := s.DB.Query(query, args...)
	if err != nil {
		return []Message{}
	}
	defer rows.Close()

	var messages []Message
	for rows.Next() {
		var msg Message
		var contentRaw string
		var localID sql.NullString
		if err := rows.Scan(&msg.ID, &msg.SessionID, &contentRaw, &msg.CreatedAt, &msg.Seq, &localID); err != nil {
			continue
		}
		msg.Content = decodeJSONValue(sql.NullString{String: contentRaw, Valid: contentRaw != ""})
		if localID.Valid {
			msg.LocalID = localID.String
		}
		messages = append(messages, msg)
	}

	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	return messages
}

func (s *Store) ListMessagesAfter(sessionID string, afterSeq int64, limit int) []Message {
	query := `SELECT id, session_id, content, created_at, seq, local_id
        FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC`
	args := []any{sessionID, afterSeq}
	if limit > 0 {
		query += " LIMIT ?"
		args = append(args, limit)
	}
	rows, err := s.DB.Query(query, args...)
	if err != nil {
		return []Message{}
	}
	defer rows.Close()

	var messages []Message
	for rows.Next() {
		var msg Message
		var contentRaw string
		var localID sql.NullString
		if err := rows.Scan(&msg.ID, &msg.SessionID, &contentRaw, &msg.CreatedAt, &msg.Seq, &localID); err != nil {
			continue
		}
		msg.Content = decodeJSONValue(sql.NullString{String: contentRaw, Valid: contentRaw != ""})
		if localID.Valid {
			msg.LocalID = localID.String
		}
		messages = append(messages, msg)
	}
	return messages
}

func (s *Store) AddMessage(sessionID string, content any, localID string) Message {
	contentRaw, _ := json.Marshal(content)
	msg := Message{
		ID:        newUUID(),
		SessionID: sessionID,
		Content:   content,
		CreatedAt: time.Now().UnixMilli(),
		Seq:       s.nextMessageSeq(sessionID),
		LocalID:   localID,
	}

	_, _ = s.DB.Exec(
		`INSERT INTO messages (id, session_id, content, created_at, seq, local_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
		msg.ID,
		msg.SessionID,
		string(contentRaw),
		msg.CreatedAt,
		msg.Seq,
		nullableString(localID),
	)

	s.DB.Exec(
		`UPDATE sessions SET seq = ?, updated_at = ? WHERE id = ?`,
		msg.Seq,
		msg.CreatedAt,
		sessionID,
	)

	return msg
}

func (s *Store) nextMessageSeq(sessionID string) int64 {
	row := s.DB.QueryRow("SELECT seq FROM sessions WHERE id = ?", sessionID)
	var seq int64
	if err := row.Scan(&seq); err != nil {
		return 1
	}
	return seq + 1
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
