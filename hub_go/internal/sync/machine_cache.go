package sync

import (
	"sync"
	"time"

	"hub_go/internal/store"
)

type MachineCache struct {
	store     *store.Store
	publisher *EventPublisher
	mu        sync.RWMutex
	machines  map[string]*Machine
}

func NewMachineCache(store *store.Store, publisher *EventPublisher) *MachineCache {
	return &MachineCache{
		store:     store,
		publisher: publisher,
		machines:  map[string]*Machine{},
	}
}

func (c *MachineCache) GetMachine(id string, namespace string) *Machine {
	c.mu.RLock()
	machine := c.machines[id]
	c.mu.RUnlock()
	if machine != nil {
		return machine
	}
	machine, _ = c.store.GetMachine(namespace, id)
	if machine == nil {
		return nil
	}
	c.mu.Lock()
	c.machines[id] = machine
	c.mu.Unlock()
	return machine
}

func (c *MachineCache) GetMachinesByNamespace(namespace string) []Machine {
	if c.store == nil {
		return nil
	}
	machines := c.store.ListMachines(namespace)
	c.mu.Lock()
	for i := range machines {
		machine := machines[i]
		c.machines[machine.ID] = &machine
	}
	c.mu.Unlock()
	return machines
}

func (c *MachineCache) HandleMachineAlive(payload MachineAlivePayload) {
	if c == nil || c.store == nil {
		return
	}
	aliveAt := clampAliveTime(payload.Time)
	if aliveAt == 0 {
		aliveAt = time.Now().UnixMilli()
	}
	machine, _ := c.store.UpsertMachine(payload.Namespace, payload.MachineID, nil, nil)
	if machine == nil {
		return
	}
	machine.Active = true
	machine.ActiveAt = aliveAt
	machine.UpdatedAt = time.Now().UnixMilli()
	_ = c.store.UpdateMachine(payload.Namespace, machine)
	c.mu.Lock()
	c.machines[payload.MachineID] = machine
	c.mu.Unlock()

	if c.publisher != nil {
		c.publisher.Emit(SyncEvent{
			Type:      "machine-updated",
			Namespace: payload.Namespace,
			MachineID: payload.MachineID,
			Data: map[string]any{
				"id":                 machine.ID,
				"namespace":          machine.Namespace,
				"createdAt":          machine.CreatedAt,
				"updatedAt":          machine.UpdatedAt,
				"metadata":           machine.Metadata,
				"metadataVersion":    machine.MetadataVersion,
				"runnerState":        machine.RunnerState,
				"runnerStateVersion": machine.RunnerStateVersion,
				"active":             machine.Active,
				"activeAt":           machine.ActiveAt,
				"seq":                machine.Seq,
			},
		})
	}
}
