package store

import "time"

type PushSubscription struct {
	ID        int64
	Namespace string
	Endpoint  string
	P256dh    string
	Auth      string
	CreatedAt int64
}

func (s *Store) UpsertPushSubscription(namespace string, endpoint string, p256dh string, auth string) error {
	now := time.Now().UnixMilli()
	_, err := s.DB.Exec(
		`INSERT INTO push_subscriptions (namespace, endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
		namespace,
		endpoint,
		p256dh,
		auth,
		now,
	)
	return err
}

func (s *Store) DeletePushSubscription(namespace string, endpoint string) error {
	_, err := s.DB.Exec(
		`DELETE FROM push_subscriptions WHERE namespace = ? AND endpoint = ?`,
		namespace,
		endpoint,
	)
	return err
}

func (s *Store) GetPushSubscriptionsByNamespace(namespace string) []PushSubscription {
	rows, err := s.DB.Query(
		`SELECT id, namespace, endpoint, p256dh, auth, created_at FROM push_subscriptions WHERE namespace = ?`,
		namespace,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var subscriptions []PushSubscription
	for rows.Next() {
		var sub PushSubscription
		if err := rows.Scan(&sub.ID, &sub.Namespace, &sub.Endpoint, &sub.P256dh, &sub.Auth, &sub.CreatedAt); err != nil {
			continue
		}
		subscriptions = append(subscriptions, sub)
	}
	return subscriptions
}
