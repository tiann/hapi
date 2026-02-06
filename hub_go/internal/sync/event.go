package sync

type SyncEvent struct {
	Type      string         `json:"type"`
	Namespace string         `json:"namespace,omitempty"`
	SessionID string         `json:"sessionId,omitempty"`
	MachineID string         `json:"machineId,omitempty"`
	Message   map[string]any `json:"message,omitempty"`
	Data      any            `json:"data,omitempty"`
}
