package tunnel

import "testing"

func TestParseHostPort_WithPort(t *testing.T) {
	host, port := parseHostPort("https://example.com:8443/path")
	if host != "example.com" || port != "8443" {
		t.Fatalf("got host=%q port=%q", host, port)
	}
}

func TestParseHostPort_NoPort(t *testing.T) {
	host, port := parseHostPort("https://example.com/path")
	if host != "example.com" || port != "443" {
		t.Fatalf("got host=%q port=%q, want example.com:443", host, port)
	}
}

func TestParseHostPort_NoScheme(t *testing.T) {
	host, port := parseHostPort("example.com:3000")
	if host != "example.com" || port != "3000" {
		t.Fatalf("got host=%q port=%q", host, port)
	}
}

func TestParseHostPort_Bare(t *testing.T) {
	host, port := parseHostPort("example.com")
	if host != "example.com" || port != "443" {
		t.Fatalf("got host=%q port=%q", host, port)
	}
}

func TestParseHostPort_IPv6(t *testing.T) {
	host, port := parseHostPort("https://[::1]:8080/path")
	if host != "::1" || port != "8080" {
		t.Fatalf("got host=%q port=%q", host, port)
	}
}

func TestGetPlatformDir(t *testing.T) {
	// just verify it returns non-empty
	got := getPlatformDir()
	if got == "" {
		t.Fatal("getPlatformDir() returned empty")
	}
	// on linux/amd64 (CI), should be "x64-linux"
	t.Logf("getPlatformDir() = %q", got)
}
