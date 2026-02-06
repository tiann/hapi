package config

import (
    "crypto/rand"
    "encoding/base64"
    "encoding/json"
    "errors"
    "os"
    "path/filepath"
)

type jwtSecretFile struct {
    SecretBase64 string `json:"secretBase64"`
}

func LoadOrCreateJWTSecret(dataDir string) ([]byte, error) {
    secretFile := filepath.Join(dataDir, "jwt-secret.json")

    raw, err := os.ReadFile(secretFile)
    if err == nil {
        var parsed jwtSecretFile
        if err := json.Unmarshal(raw, &parsed); err != nil {
            return nil, err
        }
        decoded, err := base64.StdEncoding.DecodeString(parsed.SecretBase64)
        if err != nil {
            return nil, err
        }
        if len(decoded) != 32 {
            return nil, errors.New("invalid JWT secret length")
        }
        return decoded, nil
    }

    if !errors.Is(err, os.ErrNotExist) {
        return nil, err
    }

    secret := make([]byte, 32)
    if _, err := rand.Read(secret); err != nil {
        return nil, err
    }

    payload := jwtSecretFile{SecretBase64: base64.StdEncoding.EncodeToString(secret)}
    encoded, err := json.MarshalIndent(payload, "", "    ")
    if err != nil {
        return nil, err
    }

    if err := os.MkdirAll(filepath.Dir(secretFile), 0o700); err != nil {
        return nil, err
    }

    if err := os.WriteFile(secretFile, encoded, 0o600); err != nil {
        return nil, err
    }

    return secret, nil
}
