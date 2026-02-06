package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"hub_go/internal/config"
	"hub_go/internal/server"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config error: %v", err)
	}

	jwtSecret, err := config.LoadOrCreateJWTSecret(cfg.DataDir)
	if err != nil {
		log.Fatalf("jwt secret error: %v", err)
	}

	if cfg.CliApiTokenIsNew {
		log.Printf("CLI_API_TOKEN generated (stored in %s)", cfg.SettingsFile)
	}

	srv, err := server.New(cfg, jwtSecret)
	if err != nil {
		log.Fatalf("server init error: %v", err)
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	log.Printf("hub_go listening on %s:%d", cfg.ListenHost, cfg.ListenPort)
	if err := srv.Start(); err != nil {
		if errors.Is(err, http.ErrServerClosed) {
			return
		}
		log.Fatalf("server error: %v", err)
	}
}
