package config

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type ownerIDFile struct {
	OwnerID int64 `json:"ownerId"`
}

var ownerIDOnce sync.Once
var cachedOwnerID int64
var cachedOwnerErr error

func LoadOrCreateOwnerID(dataDir string) (int64, error) {
	ownerIDOnce.Do(func() {
		cachedOwnerID, cachedOwnerErr = loadOrCreateOwnerID(dataDir)
	})
	return cachedOwnerID, cachedOwnerErr
}

func loadOrCreateOwnerID(dataDir string) (int64, error) {
	path := filepath.Join(dataDir, "owner-id.json")

	raw, err := os.ReadFile(path)
	if err == nil {
		var parsed ownerIDFile
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return 0, err
		}
		if parsed.OwnerID <= 0 {
			return 0, errors.New("invalid ownerId")
		}
		return parsed.OwnerID, nil
	}

	if !errors.Is(err, os.ErrNotExist) {
		return 0, err
	}

	ownerID, err := generateOwnerID()
	if err != nil {
		return 0, err
	}

	payload, err := json.MarshalIndent(ownerIDFile{OwnerID: ownerID}, "", "    ")
	if err != nil {
		return 0, err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return 0, err
	}

	if err := os.WriteFile(path, payload, 0o600); err != nil {
		return 0, err
	}

	return ownerID, nil
}

func generateOwnerID() (int64, error) {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return 0, err
	}

	var value int64
	for _, b := range buf {
		value = (value << 8) + int64(b)
	}
	if value <= 0 {
		return 1, nil
	}
	return value, nil
}
