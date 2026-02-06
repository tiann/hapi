package notifications

import "hub_go/internal/store"

type NotificationChannel interface {
	SendReady(session *store.Session) error
	SendPermissionRequest(session *store.Session) error
}

type NotificationHubOptions struct {
	ReadyCooldownMs      int64
	PermissionDebounceMs int64
}
