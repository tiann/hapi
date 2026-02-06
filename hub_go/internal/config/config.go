package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

const (
	defaultListenHost = "127.0.0.1"
	defaultListenPort = 3006
)

type Config struct {
	DataDir              string
	DBPath               string
	SettingsFile         string
	ListenHost           string
	ListenPort           int
	PublicURL            string
	CorsOrigins          []string
	TelegramBotToken     *string
	TelegramNotification bool
	CliApiToken          string
	CliApiTokenSource    string
	CliApiTokenIsNew     bool
}

func Load() (*Config, error) {
	dataDir, err := resolveDataDir()
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, err
	}

	settingsFile := filepath.Join(dataDir, "settings.json")
	serverSettings, err := LoadServerSettings(settingsFile)
	if err != nil {
		return nil, err
	}

	listenHost := serverSettings.ListenHost
	listenPort := serverSettings.ListenPort

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = filepath.Join(dataDir, "hapi.db")
	}

	cliApiToken, err := LoadOrCreateCliApiToken(settingsFile)
	if err != nil {
		return nil, err
	}

	return &Config{
		DataDir:              dataDir,
		DBPath:               dbPath,
		SettingsFile:         settingsFile,
		ListenHost:           listenHost,
		ListenPort:           listenPort,
		PublicURL:            serverSettings.PublicURL,
		CorsOrigins:          serverSettings.CorsOrigins,
		TelegramBotToken:     serverSettings.TelegramBotToken,
		TelegramNotification: serverSettings.TelegramNotification,
		CliApiToken:          cliApiToken.Token,
		CliApiTokenSource:    cliApiToken.Source,
		CliApiTokenIsNew:     cliApiToken.IsNew,
	}, nil
}

func resolveDataDir() (string, error) {
	if custom := os.Getenv("HAPI_HOME"); custom != "" {
		return custom, nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	if home == "" {
		return "", errors.New("cannot resolve user home dir")
	}

	return filepath.Join(home, ".hapi"), nil
}

func parsePortEnv(key string, fallback int) (int, error) {
	if raw := os.Getenv(key); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			return 0, fmt.Errorf("%s must be a valid port number", key)
		}
		return parsed, nil
	}

	return fallback, nil
}

func getenvDefault(key string, fallback string) string {
	if raw := os.Getenv(key); raw != "" {
		return raw
	}
	return fallback
}
