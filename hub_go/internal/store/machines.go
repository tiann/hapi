package store

import (
	"database/sql"
	"encoding/json"
	"time"
)

type Machine struct {
	ID                 string
	Namespace          string
	CreatedAt          int64
	UpdatedAt          int64
	Metadata           any
	MetadataVersion    int64
	RunnerState        any
	RunnerStateVersion int64
	Active             bool
	ActiveAt           int64
	Seq                int64
}

type MachineUpdateResult[T any] struct {
	Result  string
	Version int64
	Value   T
}

func (s *Store) ListMachines(namespace string) []Machine {
	rows, err := s.DB.Query(
		`SELECT id, namespace, created_at, updated_at, metadata, metadata_version, runner_state, runner_state_version, active, active_at, seq
         FROM machines WHERE namespace = ? ORDER BY updated_at DESC`,
		namespace,
	)
	if err != nil {
		return []Machine{}
	}
	defer rows.Close()

	var machines []Machine
	for rows.Next() {
		var machine Machine
		var activeInt int
		var metadataRaw sql.NullString
		var runnerStateRaw sql.NullString
		if err := rows.Scan(
			&machine.ID,
			&machine.Namespace,
			&machine.CreatedAt,
			&machine.UpdatedAt,
			&metadataRaw,
			&machine.MetadataVersion,
			&runnerStateRaw,
			&machine.RunnerStateVersion,
			&activeInt,
			&machine.ActiveAt,
			&machine.Seq,
		); err != nil {
			continue
		}
		machine.Active = activeInt == 1
		machine.Metadata = decodeJSONValue(metadataRaw)
		machine.RunnerState = decodeJSONValue(runnerStateRaw)
		machines = append(machines, machine)
	}
	return machines
}

func (s *Store) GetMachine(namespace string, id string) (*Machine, error) {
	row := s.DB.QueryRow(
		`SELECT id, namespace, created_at, updated_at, metadata, metadata_version, runner_state, runner_state_version, active, active_at, seq
         FROM machines WHERE id = ? AND namespace = ? LIMIT 1`,
		id,
		namespace,
	)

	var machine Machine
	var activeInt int
	var metadataRaw sql.NullString
	var runnerStateRaw sql.NullString
	if err := row.Scan(
		&machine.ID,
		&machine.Namespace,
		&machine.CreatedAt,
		&machine.UpdatedAt,
		&metadataRaw,
		&machine.MetadataVersion,
		&runnerStateRaw,
		&machine.RunnerStateVersion,
		&activeInt,
		&machine.ActiveAt,
		&machine.Seq,
	); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	machine.Active = activeInt == 1
	machine.Metadata = decodeJSONValue(metadataRaw)
	machine.RunnerState = decodeJSONValue(runnerStateRaw)
	return &machine, nil
}

func (s *Store) MachineExists(id string) bool {
	row := s.DB.QueryRow("SELECT 1 FROM machines WHERE id = ? LIMIT 1", id)
	var value int
	if err := row.Scan(&value); err != nil {
		return false
	}
	return value == 1
}

func (s *Store) UpsertMachine(namespace string, id string, metadata any, runnerState any) (*Machine, error) {
	if id == "" {
		return nil, nil
	}
	existing, _ := s.GetMachine(namespace, id)
	now := time.Now().UnixMilli()

	metadataRaw, _ := json.Marshal(metadata)
	runnerStateRaw, _ := json.Marshal(runnerState)

	if existing == nil {
		_, err := s.DB.Exec(
			`INSERT INTO machines (
                id, namespace, created_at, updated_at, metadata, metadata_version, runner_state, runner_state_version, active, active_at, seq
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id,
			namespace,
			now,
			now,
			string(metadataRaw),
			1,
			string(runnerStateRaw),
			1,
			0,
			0,
			0,
		)
		if err != nil {
			return nil, err
		}
		return s.GetMachine(namespace, id)
	}

	metadataVersion := existing.MetadataVersion
	runnerVersion := existing.RunnerStateVersion
	if metadata != nil {
		metadataVersion++
	}
	if runnerState != nil {
		runnerVersion++
	}

	_, err := s.DB.Exec(
		`UPDATE machines SET
            updated_at = ?, metadata = ?, metadata_version = ?, runner_state = ?, runner_state_version = ?
         WHERE id = ? AND namespace = ?`,
		now,
		string(metadataRaw),
		metadataVersion,
		string(runnerStateRaw),
		runnerVersion,
		id,
		namespace,
	)
	if err != nil {
		return nil, err
	}
	return s.GetMachine(namespace, id)
}

func (s *Store) UpdateMachine(namespace string, machine *Machine) error {
	if machine == nil {
		return nil
	}
	metadataRaw, _ := json.Marshal(machine.Metadata)
	runnerStateRaw, _ := json.Marshal(machine.RunnerState)
	active := 0
	if machine.Active {
		active = 1
	}
	_, err := s.DB.Exec(
		`UPDATE machines SET
            updated_at = ?, metadata = ?, metadata_version = ?, runner_state = ?, runner_state_version = ?, active = ?, active_at = ?, seq = ?
         WHERE id = ? AND namespace = ?`,
		machine.UpdatedAt,
		string(metadataRaw),
		machine.MetadataVersion,
		string(runnerStateRaw),
		machine.RunnerStateVersion,
		active,
		machine.ActiveAt,
		machine.Seq,
		machine.ID,
		namespace,
	)
	return err
}

func (s *Store) UpdateMachineMetadata(namespace string, id string, metadata any, expectedVersion int64) (MachineUpdateResult[any], error) {
	machine, err := s.GetMachine(namespace, id)
	if err != nil {
		return MachineUpdateResult[any]{Result: "error"}, err
	}
	if machine == nil {
		return MachineUpdateResult[any]{Result: "error"}, nil
	}
	if expectedVersion != machine.MetadataVersion {
		return MachineUpdateResult[any]{Result: "version-mismatch", Version: machine.MetadataVersion, Value: machine.Metadata}, nil
	}
	machine.MetadataVersion++
	machine.Metadata = metadata
	machine.UpdatedAt = time.Now().UnixMilli()
	if err := s.updateMachine(machine); err != nil {
		return MachineUpdateResult[any]{Result: "error"}, err
	}
	return MachineUpdateResult[any]{Result: "success", Version: machine.MetadataVersion, Value: machine.Metadata}, nil
}

func (s *Store) UpdateMachineRunnerState(namespace string, id string, runnerState any, expectedVersion int64) (MachineUpdateResult[any], error) {
	machine, err := s.GetMachine(namespace, id)
	if err != nil {
		return MachineUpdateResult[any]{Result: "error"}, err
	}
	if machine == nil {
		return MachineUpdateResult[any]{Result: "error"}, nil
	}
	if expectedVersion != machine.RunnerStateVersion {
		return MachineUpdateResult[any]{Result: "version-mismatch", Version: machine.RunnerStateVersion, Value: machine.RunnerState}, nil
	}
	machine.RunnerStateVersion++
	machine.RunnerState = runnerState
	machine.UpdatedAt = time.Now().UnixMilli()
	if err := s.updateMachine(machine); err != nil {
		return MachineUpdateResult[any]{Result: "error"}, err
	}
	return MachineUpdateResult[any]{Result: "success", Version: machine.RunnerStateVersion, Value: machine.RunnerState}, nil
}

func (s *Store) updateMachine(machine *Machine) error {
	if machine == nil {
		return nil
	}
	metadataRaw, _ := json.Marshal(machine.Metadata)
	runnerStateRaw, _ := json.Marshal(machine.RunnerState)
	active := 0
	if machine.Active {
		active = 1
	}
	_, err := s.DB.Exec(
		`UPDATE machines SET
            updated_at = ?, metadata = ?, metadata_version = ?, runner_state = ?, runner_state_version = ?, active = ?, active_at = ?, seq = ?
         WHERE id = ? AND namespace = ?`,
		machine.UpdatedAt,
		string(metadataRaw),
		machine.MetadataVersion,
		string(runnerStateRaw),
		machine.RunnerStateVersion,
		active,
		machine.ActiveAt,
		machine.Seq,
		machine.ID,
		machine.Namespace,
	)
	return err
}
