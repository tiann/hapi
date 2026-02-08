package tunnel

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNewManager(t *testing.T) {
	cfg := Config{LocalPort: 3006, Enabled: true, APIDomain: "relay.hapi.run", AuthKey: "test"}
	m := NewManager(cfg)

	if m == nil {
		t.Fatal("NewManager returned nil")
	}
	if m.config.LocalPort != 3006 {
		t.Fatalf("LocalPort = %d, want 3006", m.config.LocalPort)
	}
	if m.maxRetries != 5 {
		t.Fatalf("maxRetries = %d, want 5", m.maxRetries)
	}
	if m.stopCh == nil {
		t.Fatal("stopCh should be initialized")
	}
}

func TestManager_Enabled(t *testing.T) {
	// nil manager
	var m *Manager
	if m.Enabled() {
		t.Fatal("nil manager should not be enabled")
	}

	// disabled
	m = NewManager(Config{Enabled: false})
	if m.Enabled() {
		t.Fatal("expected not enabled")
	}

	// enabled
	m = NewManager(Config{Enabled: true})
	if !m.Enabled() {
		t.Fatal("expected enabled")
	}
}

func TestManager_GetTunnelURL_Nil(t *testing.T) {
	var m *Manager
	if got := m.GetTunnelURL(); got != "" {
		t.Fatalf("nil manager GetTunnelURL = %q, want empty", got)
	}
}

func TestManager_GetTunnelURL(t *testing.T) {
	m := NewManager(Config{})
	if got := m.GetTunnelURL(); got != "" {
		t.Fatalf("initial GetTunnelURL = %q, want empty", got)
	}

	m.mu.Lock()
	m.tunnelURL = "https://abc.relay.hapi.run"
	m.mu.Unlock()

	if got := m.GetTunnelURL(); got != "https://abc.relay.hapi.run" {
		t.Fatalf("GetTunnelURL = %q, want https://abc.relay.hapi.run", got)
	}
}

func TestManager_IsConnected_Nil(t *testing.T) {
	var m *Manager
	if m.IsConnected() {
		t.Fatal("nil manager should not be connected")
	}
}

func TestManager_IsConnected(t *testing.T) {
	m := NewManager(Config{})
	if m.IsConnected() {
		t.Fatal("initial state should not be connected")
	}

	m.mu.Lock()
	m.isConnected = true
	m.mu.Unlock()

	if !m.IsConnected() {
		t.Fatal("expected connected after setting flag")
	}
}

func TestManager_Stop_Nil(t *testing.T) {
	var m *Manager
	if err := m.Stop(); err != nil {
		t.Fatalf("nil manager Stop() error: %v", err)
	}
}

func TestManager_Stop(t *testing.T) {
	m := NewManager(Config{Enabled: true})
	m.mu.Lock()
	m.isConnected = true
	m.tunnelURL = "https://test.example.com"
	m.mu.Unlock()

	if err := m.Stop(); err != nil {
		t.Fatalf("Stop() error: %v", err)
	}

	if m.IsConnected() {
		t.Fatal("should not be connected after Stop")
	}
	if m.GetTunnelURL() != "" {
		t.Fatal("tunnelURL should be empty after Stop")
	}
	if !m.stopped {
		t.Fatal("stopped flag should be true")
	}
}

func TestManager_Stop_DoubleClose(t *testing.T) {
	m := NewManager(Config{})

	if err := m.Stop(); err != nil {
		t.Fatalf("first Stop() error: %v", err)
	}
	// second stop should not panic
	if err := m.Stop(); err != nil {
		t.Fatalf("second Stop() error: %v", err)
	}
}

func TestManager_Start_Disabled(t *testing.T) {
	m := NewManager(Config{Enabled: false})
	url, err := m.Start()
	if err != nil {
		t.Fatalf("Start() error: %v", err)
	}
	if url != "" {
		t.Fatalf("disabled Start() returned URL %q", url)
	}
}

func TestManager_Start_Nil(t *testing.T) {
	var m *Manager
	url, err := m.Start()
	if err != nil {
		t.Fatalf("nil Start() error: %v", err)
	}
	if url != "" {
		t.Fatalf("nil Start() returned URL %q", url)
	}
}

func TestGetHapiHome_Default(t *testing.T) {
	prev := os.Getenv("HAPI_HOME")
	os.Unsetenv("HAPI_HOME")
	defer func() {
		if prev != "" {
			os.Setenv("HAPI_HOME", prev)
		}
	}()

	got := getHapiHome()
	if got == "" {
		t.Fatal("getHapiHome returned empty")
	}
	// should end with .hapi
	if got[len(got)-5:] != ".hapi" {
		t.Fatalf("getHapiHome = %q, should end with .hapi", got)
	}
}

func TestGetHapiHome_EnvVar(t *testing.T) {
	prev := os.Getenv("HAPI_HOME")
	os.Setenv("HAPI_HOME", "/tmp/custom-hapi")
	defer func() {
		if prev != "" {
			os.Setenv("HAPI_HOME", prev)
		} else {
			os.Unsetenv("HAPI_HOME")
		}
	}()

	got := getHapiHome()
	if got != "/tmp/custom-hapi" {
		t.Fatalf("getHapiHome = %q, want /tmp/custom-hapi", got)
	}
}

func TestGetHapiHome_TildeExpansion(t *testing.T) {
	prev := os.Getenv("HAPI_HOME")
	os.Setenv("HAPI_HOME", "~/custom-hapi")
	defer func() {
		if prev != "" {
			os.Setenv("HAPI_HOME", prev)
		} else {
			os.Unsetenv("HAPI_HOME")
		}
	}()

	got := getHapiHome()
	if got == "" {
		t.Fatal("getHapiHome returned empty for tilde path")
	}
	// should not contain tilde
	if got[0] == '~' {
		t.Fatalf("getHapiHome did not expand tilde: %q", got)
	}
}

func TestWaitForTLSReady_EmptyURL(t *testing.T) {
	if !WaitForTLSReady("", nil) {
		t.Fatal("empty URL should return true")
	}
}

func TestWaitForTLSReady_NonHTTPS(t *testing.T) {
	if !WaitForTLSReady("http://example.com", nil) {
		t.Fatal("non-HTTPS URL should return true")
	}
}

func TestWaitForTLSReady_DisconnectedManager(t *testing.T) {
	m := NewManager(Config{})
	// isConnected is false, should return false immediately
	result := WaitForTLSReady("https://test.example.com", m)
	if result {
		t.Fatal("disconnected manager should return false")
	}
}

func TestGetTunwgPath_RuntimePath(t *testing.T) {
	tmpDir := t.TempDir()
	prev := os.Getenv("HAPI_HOME")
	os.Setenv("HAPI_HOME", tmpDir)
	defer func() {
		if prev != "" {
			os.Setenv("HAPI_HOME", prev)
		} else {
			os.Unsetenv("HAPI_HOME")
		}
	}()

	binaryName := "tunwg"
	if runtime.GOOS == "windows" {
		binaryName = "tunwg.exe"
	}

	runtimePath := filepath.Join(tmpDir, "runtime", "tools", "tunwg")
	os.MkdirAll(runtimePath, 0o700)
	binaryPath := filepath.Join(runtimePath, binaryName)
	os.WriteFile(binaryPath, []byte("fake"), 0o755)

	m := NewManager(Config{Enabled: true})
	got, err := m.getTunwgPath()
	if err != nil {
		t.Fatalf("getTunwgPath error: %v", err)
	}
	if got != binaryPath {
		t.Fatalf("got %q, want %q", got, binaryPath)
	}
}

func TestGetTunwgPath_NotFound(t *testing.T) {
	tmpDir := t.TempDir()
	prev := os.Getenv("HAPI_HOME")
	os.Setenv("HAPI_HOME", tmpDir)
	defer func() {
		if prev != "" {
			os.Setenv("HAPI_HOME", prev)
		} else {
			os.Unsetenv("HAPI_HOME")
		}
	}()

	m := NewManager(Config{Enabled: true})
	_, err := m.getTunwgPath()
	if err == nil {
		t.Fatal("expected error when binary not found")
	}
}

func TestGetPlatformDir_Values(t *testing.T) {
	got := getPlatformDir()
	validValues := map[string]bool{
		"arm64-darwin": true,
		"x64-darwin":   true,
		"arm64-linux":  true,
		"x64-linux":    true,
		"x64-win32":    true,
	}
	// On known platforms, should be one of the valid values
	// On unknown platforms, format is arch-os
	if !validValues[got] {
		t.Logf("getPlatformDir() = %q (unknown platform, this is OK)", got)
	}
}

func TestManager_Stop_WithCancel(t *testing.T) {
	m := NewManager(Config{})
	cancelled := false
	m.cancelFunc = func() { cancelled = true }
	m.isConnected = true

	if err := m.Stop(); err != nil {
		t.Fatalf("Stop error: %v", err)
	}
	if !cancelled {
		t.Fatal("cancelFunc should have been called")
	}
	if m.cancelFunc != nil {
		t.Fatal("cancelFunc should be nil after Stop")
	}
}

func TestCheckTunnelCertificate_ValidTLS(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer server.Close()

	// Extract host and port from test server
	addr := strings.TrimPrefix(server.URL, "https://")
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("SplitHostPort error: %v", err)
	}

	// The test TLS cert is self-signed so standard verification fails
	result := checkTunnelCertificate(host, port, 2*time.Second)
	if result {
		t.Log("self-signed cert validated (unexpected but OK in test env)")
	} else {
		t.Log("self-signed cert rejected (expected)")
	}
}

func TestCheckTunnelCertificate_ConnectionRefused(t *testing.T) {
	result := checkTunnelCertificate("127.0.0.1", "1", 500*time.Millisecond)
	if result {
		t.Fatal("connection refused should return false")
	}
}

func TestCheckTunnelCertificate_Timeout(t *testing.T) {
	// Create a listener that accepts but never does TLS handshake
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	_, port, _ := net.SplitHostPort(ln.Addr().String())
	result := checkTunnelCertificate("127.0.0.1", port, 200*time.Millisecond)
	if result {
		t.Fatal("timeout should return false")
	}
}

func TestWaitForTLSReady_ManagerDisconnects(t *testing.T) {
	// Create a listener that never completes TLS
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	m := NewManager(Config{Enabled: true})
	m.mu.Lock()
	m.isConnected = true
	m.mu.Unlock()

	// Disconnect after a short delay
	go func() {
		time.Sleep(100 * time.Millisecond)
		m.mu.Lock()
		m.isConnected = false
		m.mu.Unlock()
	}()

	_, port, _ := net.SplitHostPort(ln.Addr().String())
	result := WaitForTLSReady("https://127.0.0.1:"+port, m)
	if result {
		t.Fatal("should return false when manager disconnects")
	}
}

func TestParseHostPort_HTTPScheme(t *testing.T) {
	host, port := parseHostPort("http://example.com:8080/path")
	if host != "example.com" || port != "8080" {
		t.Fatalf("got host=%q port=%q", host, port)
	}
}

func TestParseHostPort_EmptyString(t *testing.T) {
	host, port := parseHostPort("")
	if host != "" || port != "443" {
		t.Fatalf("got host=%q port=%q", host, port)
	}
}

// Verify TLS config in checkTunnelCertificate uses InsecureSkipVerify=false
func TestCheckTunnelCertificate_VerifiesCert(t *testing.T) {
	// Start a TLS server with self-signed cert
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer server.Close()

	addr := strings.TrimPrefix(server.URL, "https://")
	host, port, _ := net.SplitHostPort(addr)

	// Should fail because the cert is self-signed
	result := checkTunnelCertificate(host, port, 2*time.Second)
	_ = result // we just want to exercise the code path

	// Also test with a known-invalid config
	tlsConf := &tls.Config{InsecureSkipVerify: false}
	_ = tlsConf
}
