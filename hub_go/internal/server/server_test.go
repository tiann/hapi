package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"hub_go/internal/config"
)

func setupTestConfig(t *testing.T) *config.Config {
	t.Helper()
	tmpDir := t.TempDir()
	dbPath := filepath.Join(tmpDir, "test.db")
	settingsFile := filepath.Join(tmpDir, "settings.json")

	// Write minimal settings file
	os.WriteFile(settingsFile, []byte(`{}`), 0o600)

	return &config.Config{
		DataDir:      tmpDir,
		DBPath:       dbPath,
		SettingsFile: settingsFile,
		ListenHost:   "127.0.0.1",
		ListenPort:   0, // random port
		PublicURL:    "http://localhost:3006",
		CliApiToken:  "test-token",
	}
}

func TestNew(t *testing.T) {
	cfg := setupTestConfig(t)
	jwtSecret := []byte("test-jwt-secret-at-least-32-byte")

	srv, err := New(cfg, jwtSecret)
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}
	if srv == nil {
		t.Fatal("server is nil")
	}
	if srv.store == nil {
		t.Fatal("store is nil")
	}
	if srv.sseBus == nil {
		t.Fatal("sseBus is nil")
	}
	if srv.socketIO == nil {
		t.Fatal("socketIO is nil")
	}
	if srv.notificationHub == nil {
		t.Fatal("notificationHub is nil")
	}
	// Tunnel manager should exist but be disabled
	if srv.tunnelManager == nil {
		t.Fatal("tunnelManager is nil")
	}
	// Telegram bot should be nil (no token)
	if srv.telegramBot != nil {
		t.Fatal("telegramBot should be nil without token")
	}

	// Clean up
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

func TestNew_WithTelegramToken(t *testing.T) {
	cfg := setupTestConfig(t)
	token := "123456:ABC-DEF"
	cfg.TelegramBotToken = &token
	cfg.TelegramNotification = true
	jwtSecret := []byte("test-jwt-secret-at-least-32-byte")

	srv, err := New(cfg, jwtSecret)
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	if srv.telegramBot == nil {
		t.Fatal("telegramBot should be created when token is provided")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

func TestNew_WithRelay(t *testing.T) {
	cfg := setupTestConfig(t)
	cfg.RelayEnabled = true
	cfg.RelayAPIDomain = "relay.example.com"
	jwtSecret := []byte("test-jwt-secret-at-least-32-byte")

	srv, err := New(cfg, jwtSecret)
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	if srv.tunnelManager == nil {
		t.Fatal("tunnelManager should be created")
	}
	if !srv.tunnelManager.Enabled() {
		t.Fatal("tunnelManager should be enabled")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
}

func TestNew_InvalidDBPath(t *testing.T) {
	cfg := setupTestConfig(t)
	cfg.DBPath = "/nonexistent/path/to/db"
	jwtSecret := []byte("test-jwt-secret-at-least-32-byte")

	_, err := New(cfg, jwtSecret)
	if err == nil {
		t.Fatal("expected error for invalid DB path")
	}
}

func TestShutdown(t *testing.T) {
	cfg := setupTestConfig(t)
	jwtSecret := []byte("test-jwt-secret-at-least-32-byte")

	srv, err := New(cfg, jwtSecret)
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = srv.Shutdown(ctx)
	if err != nil {
		t.Fatalf("Shutdown() error: %v", err)
	}

	// Double shutdown should not panic
	err = srv.Shutdown(ctx)
	// May return error (server already closed), but should not panic
	_ = err
}

func TestShutdown_WithAllComponents(t *testing.T) {
	cfg := setupTestConfig(t)
	token := "123456:ABC-DEF"
	cfg.TelegramBotToken = &token
	cfg.TelegramNotification = true
	cfg.RelayEnabled = true
	jwtSecret := []byte("test-jwt-secret-at-least-32-byte")

	srv, err := New(cfg, jwtSecret)
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = srv.Shutdown(ctx)
	if err != nil {
		t.Fatalf("Shutdown() error: %v", err)
	}
}
