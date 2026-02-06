package sync

type SessionAlivePayload struct {
	SessionID      string
	Time           int64
	Thinking       bool
	PermissionMode string
	ModelMode      string
	Namespace      string
}

type SessionEndPayload struct {
	SessionID string
	Time      int64
	Namespace string
}

type MachineAlivePayload struct {
	MachineID string
	Time      int64
	Namespace string
}
