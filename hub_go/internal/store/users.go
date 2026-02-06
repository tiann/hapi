package store

import (
	"database/sql"
	"time"
)

type User struct {
	ID             int64
	Platform       string
	PlatformUserID string
	Namespace      string
	CreatedAt      int64
}

func (s *Store) GetUser(platform string, platformUserID string) (*User, error) {
	row := s.DB.QueryRow(
		"SELECT id, platform, platform_user_id, namespace, created_at FROM users WHERE platform = ? AND platform_user_id = ? LIMIT 1",
		platform,
		platformUserID,
	)

	var user User
	if err := row.Scan(&user.ID, &user.Platform, &user.PlatformUserID, &user.Namespace, &user.CreatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}

	return &user, nil
}

func (s *Store) AddUser(platform string, platformUserID string, namespace string) (*User, error) {
	now := time.Now().UnixMilli()
	_, err := s.DB.Exec(
		`INSERT OR IGNORE INTO users (platform, platform_user_id, namespace, created_at) VALUES (?, ?, ?, ?)`,
		platform,
		platformUserID,
		namespace,
		now,
	)
	if err != nil {
		return nil, err
	}

	return s.GetUser(platform, platformUserID)
}
