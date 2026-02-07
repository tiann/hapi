package tunnel

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Config contains tunnel configuration
type Config struct {
	LocalPort int
	Enabled   bool
	APIDomain string // TUNWG_API - default: relay.hapi.run
	AuthKey   string // TUNWG_AUTH - default: hapi
	UseRelay  bool   // TUNWG_RELAY
}

// Manager manages the tunwg subprocess lifecycle
type Manager struct {
	config      Config
	process     *exec.Cmd
	tunnelURL   string
	isConnected bool
	lastError   string
	retryCount  int
	maxRetries  int
	retryDelay  time.Duration
	stopped     bool
	mu          sync.Mutex
	stopCh      chan struct{}
	cancelFunc  context.CancelFunc
}

// TunwgEvent represents an event from tunwg JSON output
type TunwgEvent struct {
	Event string `json:"event"`
	URL   string `json:"url"`
}

// NewManager creates a new tunnel manager
func NewManager(config Config) *Manager {
	return &Manager{
		config:     config,
		maxRetries: 5,
		retryDelay: 3 * time.Second,
		stopCh:     make(chan struct{}),
	}
}

// Start starts the tunnel and returns the tunnel URL
func (m *Manager) Start() (string, error) {
	if m == nil || !m.config.Enabled {
		return "", nil
	}

	m.mu.Lock()
	m.stopped = false
	m.stopCh = make(chan struct{})
	m.mu.Unlock()

	return m.spawnTunwg()
}

func (m *Manager) spawnTunwg() (string, error) {
	tunwgPath, err := m.getTunwgPath()
	if err != nil {
		return "", err
	}

	if _, err := os.Stat(tunwgPath); os.IsNotExist(err) {
		return "", fmt.Errorf("tunwg binary not found at %s", tunwgPath)
	}

	forwardURL := fmt.Sprintf("http://localhost:%d", m.config.LocalPort)

	// Set up environment
	env := os.Environ()
	hapiHome := getHapiHome()

	env = append(env, fmt.Sprintf("TUNWG_PATH=%s", filepath.Join(hapiHome, "tunwg")))

	if m.config.APIDomain != "" {
		env = append(env, fmt.Sprintf("TUNWG_API=%s", m.config.APIDomain))
	}

	authKey := m.config.AuthKey
	if authKey == "" {
		authKey = "hapi"
	}
	env = append(env, fmt.Sprintf("TUNWG_AUTH=%s", authKey))

	if m.config.UseRelay {
		env = append(env, "TUNWG_RELAY=true")
	}

	log.Printf("[Tunnel] Starting tunnel to %s...", forwardURL)

	ctx, cancel := context.WithCancel(context.Background())
	m.mu.Lock()
	m.cancelFunc = cancel
	m.mu.Unlock()

	cmd := exec.CommandContext(ctx, tunwgPath, "--json", fmt.Sprintf("--forward=%s", forwardURL))
	cmd.Env = env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return "", err
	}

	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		return "", err
	}

	if err := cmd.Start(); err != nil {
		cancel()
		return "", err
	}

	m.mu.Lock()
	m.process = cmd
	m.mu.Unlock()

	// Read stderr in background
	go func() {
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				log.Printf("[Tunnel] %s", line)
			}
		}
	}()

	// Wait for tunnel URL from stdout
	urlCh := make(chan string, 1)
	errCh := make(chan error, 1)

	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}

			var event TunwgEvent
			if err := json.Unmarshal([]byte(line), &event); err != nil {
				log.Printf("[Tunnel] %s", line)
				continue
			}

			if event.Event == "ready" && event.URL != "" {
				urlCh <- event.URL
				return
			}

			log.Printf("[Tunnel] %s", line)
		}
		if err := scanner.Err(); err != nil {
			errCh <- err
		}
	}()

	// Handle process exit
	go func() {
		exitErr := cmd.Wait()

		m.mu.Lock()
		m.isConnected = false
		m.process = nil
		stopped := m.stopped
		m.mu.Unlock()

		if stopped {
			return
		}

		if exitErr != nil {
			m.mu.Lock()
			m.lastError = fmt.Sprintf("tunwg exited with error: %v", exitErr)
			retryCount := m.retryCount
			m.mu.Unlock()

			log.Printf("[Tunnel] %s", m.lastError)

			// Auto-restart with exponential backoff
			if retryCount < m.maxRetries {
				m.mu.Lock()
				m.retryCount++
				delay := m.retryDelay * time.Duration(1<<(m.retryCount-1))
				m.mu.Unlock()

				log.Printf("[Tunnel] Restarting in %v (attempt %d/%d)", delay, retryCount+1, m.maxRetries)

				select {
				case <-m.stopCh:
					return
				case <-time.After(delay):
					if _, err := m.spawnTunwg(); err != nil {
						log.Printf("[Tunnel] Restart failed: %v", err)
					}
				}
			} else {
				log.Printf("[Tunnel] Max retries reached. Tunnel disabled.")
			}
		}
	}()

	// Wait for URL or timeout
	select {
	case url := <-urlCh:
		m.mu.Lock()
		m.tunnelURL = url
		m.isConnected = true
		m.retryCount = 0
		m.mu.Unlock()
		log.Printf("[Tunnel] Connected: %s", url)
		return url, nil
	case err := <-errCh:
		return "", err
	case <-time.After(30 * time.Second):
		m.Stop()
		return "", errors.New("timeout waiting for tunnel URL")
	case <-m.stopCh:
		return "", errors.New("tunnel stopped")
	}
}

// Stop stops the tunnel
func (m *Manager) Stop() error {
	if m == nil {
		return nil
	}

	m.mu.Lock()
	m.stopped = true

	if m.cancelFunc != nil {
		m.cancelFunc()
		m.cancelFunc = nil
	}

	select {
	case <-m.stopCh:
		// Already closed
	default:
		close(m.stopCh)
	}

	m.isConnected = false
	m.tunnelURL = ""
	m.mu.Unlock()

	return nil
}

// GetTunnelURL returns the current tunnel URL
func (m *Manager) GetTunnelURL() string {
	if m == nil {
		return ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.tunnelURL
}

// IsConnected returns whether the tunnel is connected
func (m *Manager) IsConnected() bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.isConnected
}

// Enabled returns whether the tunnel is enabled
func (m *Manager) Enabled() bool {
	if m == nil {
		return false
	}
	return m.config.Enabled
}

func (m *Manager) getTunwgPath() (string, error) {
	hapiHome := getHapiHome()
	platformDir := getPlatformDir()

	isWin := runtime.GOOS == "windows"
	tunwgBinary := "tunwg"
	if isWin {
		tunwgBinary = "tunwg.exe"
	}

	// Check for binary in runtime path (production)
	runtimePath := filepath.Join(hapiHome, "runtime", "tools", "tunwg", tunwgBinary)
	if _, err := os.Stat(runtimePath); err == nil {
		return runtimePath, nil
	}

	// Check for binary in development tools path
	var devBinaryName string
	if !isWin {
		devBinaryName = fmt.Sprintf("tunwg-%s", platformDir)
	} else {
		devBinaryName = fmt.Sprintf("tunwg-%s.exe", platformDir)
	}

	// Check multiple potential paths
	potentialPaths := []string{
		filepath.Join("tools", "tunwg", devBinaryName),
		filepath.Join("..", "hub", "tools", "tunwg", devBinaryName),
	}

	for _, p := range potentialPaths {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}

	return "", fmt.Errorf("tunwg binary not found for platform %s", platformDir)
}

func getHapiHome() string {
	if home := os.Getenv("HAPI_HOME"); home != "" {
		if strings.HasPrefix(home, "~") {
			userHome, _ := os.UserHomeDir()
			suffix := strings.TrimPrefix(home, "~")
			suffix = strings.TrimLeft(suffix, "/\\")
			home = filepath.Join(userHome, suffix)
		}
		return home
	}
	userHome, _ := os.UserHomeDir()
	return filepath.Join(userHome, ".hapi")
}

func getPlatformDir() string {
	os := runtime.GOOS
	arch := runtime.GOARCH

	switch os {
	case "darwin":
		if arch == "arm64" {
			return "arm64-darwin"
		}
		return "x64-darwin"
	case "linux":
		if arch == "arm64" {
			return "arm64-linux"
		}
		return "x64-linux"
	case "windows":
		return "x64-win32"
	default:
		return fmt.Sprintf("%s-%s", arch, os)
	}
}

// TLS Gate - Certificate validation for tunnel URLs

// WaitForTLSReady waits for the tunnel to have a valid TLS certificate
func WaitForTLSReady(tunnelURL string, manager *Manager) bool {
	if tunnelURL == "" {
		return true
	}

	// Parse the URL
	if !strings.HasPrefix(tunnelURL, "https://") {
		return true
	}

	host, port := parseHostPort(tunnelURL)
	if host == "" {
		return true
	}

	pollInterval := 1500 * time.Millisecond
	requestTimeout := 2500 * time.Millisecond
	logInterval := 15 * time.Second
	var lastLogAt time.Time

	for manager.IsConnected() {
		if checkTunnelCertificate(host, port, requestTimeout) {
			return true
		}

		if time.Since(lastLogAt) >= logInterval {
			log.Println("[Tunnel] Waiting for trusted TLS certificate...")
			lastLogAt = time.Now()
		}

		time.Sleep(pollInterval)
	}

	return false
}

func parseHostPort(rawURL string) (string, string) {
	// Remove scheme
	url := strings.TrimPrefix(rawURL, "https://")
	url = strings.TrimPrefix(url, "http://")

	// Remove path
	if idx := strings.Index(url, "/"); idx != -1 {
		url = url[:idx]
	}

	// Split host:port
	if idx := strings.LastIndex(url, ":"); idx != -1 {
		return url[:idx], url[idx+1:]
	}

	return url, "443"
}

func checkTunnelCertificate(host, port string, timeout time.Duration) bool {
	addr := net.JoinHostPort(host, port)

	dialer := &net.Dialer{Timeout: timeout}
	conn, err := tls.DialWithDialer(dialer, "tcp", addr, &tls.Config{
		ServerName:         host,
		InsecureSkipVerify: false,
	})
	if err != nil {
		return false
	}
	defer conn.Close()

	// Connection succeeded with valid certificate
	return true
}
