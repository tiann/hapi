package config

import "testing"

// ── parseCorsOrigins ──

func TestParseCorsOrigins_Basic(t *testing.T) {
	got := parseCorsOrigins("https://example.com, https://other.com")
	if len(got) != 2 || got[0] != "https://example.com" || got[1] != "https://other.com" {
		t.Fatalf("got %v", got)
	}
}

func TestParseCorsOrigins_Wildcard(t *testing.T) {
	got := parseCorsOrigins("https://example.com, *")
	if len(got) != 1 || got[0] != "*" {
		t.Fatalf("wildcard should short-circuit, got %v", got)
	}
}

func TestParseCorsOrigins_StripsPath(t *testing.T) {
	got := parseCorsOrigins("https://example.com/path/to/resource")
	if len(got) != 1 || got[0] != "https://example.com" {
		t.Fatalf("should strip path, got %v", got)
	}
}

func TestParseCorsOrigins_SkipsEmpty(t *testing.T) {
	got := parseCorsOrigins("https://a.com, , https://b.com")
	if len(got) != 2 {
		t.Fatalf("should skip empty, got %v", got)
	}
}

func TestParseCorsOrigins_PreservesPort(t *testing.T) {
	got := parseCorsOrigins("https://localhost:8080")
	if len(got) != 1 || got[0] != "https://localhost:8080" {
		t.Fatalf("should preserve port, got %v", got)
	}
}

func TestParseCorsOrigins_NoScheme(t *testing.T) {
	got := parseCorsOrigins("no-scheme-value")
	if len(got) != 1 || got[0] != "no-scheme-value" {
		t.Fatalf("no scheme should be passed through, got %v", got)
	}
}

// ── deriveCorsOrigins ──

func TestDeriveCorsOrigins_Valid(t *testing.T) {
	got := deriveCorsOrigins("https://example.com:3006")
	if len(got) != 1 || got[0] != "https://example.com:3006" {
		t.Fatalf("got %v", got)
	}
}

func TestDeriveCorsOrigins_StripPath(t *testing.T) {
	got := deriveCorsOrigins("http://localhost:3006/api/v1")
	if len(got) != 1 || got[0] != "http://localhost:3006" {
		t.Fatalf("got %v", got)
	}
}

func TestDeriveCorsOrigins_Invalid(t *testing.T) {
	got := deriveCorsOrigins("not-a-url")
	if len(got) != 0 {
		t.Fatalf("invalid URL = %v", got)
	}
}

// ── pad32 ──

func TestPad32_Short(t *testing.T) {
	input := []byte{1, 2, 3}
	got := pad32(input)
	if len(got) != 32 {
		t.Fatalf("len = %d", len(got))
	}
	// last 3 bytes should be the input
	if got[29] != 1 || got[30] != 2 || got[31] != 3 {
		t.Fatalf("padding wrong: %v", got)
	}
	// leading bytes should be zero
	for i := 0; i < 29; i++ {
		if got[i] != 0 {
			t.Fatalf("byte %d = %d, want 0", i, got[i])
		}
	}
}

func TestPad32_Exact(t *testing.T) {
	input := make([]byte, 32)
	input[0] = 0xFF
	got := pad32(input)
	if len(got) != 32 || got[0] != 0xFF {
		t.Fatalf("exact 32 bytes should pass through, got len=%d", len(got))
	}
}

func TestPad32_Longer(t *testing.T) {
	input := make([]byte, 33)
	got := pad32(input)
	if len(got) != 33 {
		t.Fatalf("longer input should pass through, got len=%d", len(got))
	}
}

// ── isWeakToken ──

func TestIsWeakToken_Short(t *testing.T) {
	if !isWeakToken("short") {
		t.Fatal("tokens < 16 chars should be weak")
	}
}

func TestIsWeakToken_WeakPatterns(t *testing.T) {
	for _, weak := range []string{"abcdefghijklmnop", "123456789012345678", "passwordXXXXXXXX", "secretXXXXXXXXXX", "tokenXXXXXXXXXXX"} {
		if !isWeakToken(weak) {
			t.Fatalf("%q should be weak", weak)
		}
	}
}

func TestIsWeakToken_AllSame(t *testing.T) {
	if !isWeakToken("aaaaaaaaaaaaaaaa") {
		t.Fatal("all same chars should be weak")
	}
}

func TestIsWeakToken_DigitsOnly(t *testing.T) {
	if !isWeakToken("1234567890123456") {
		t.Fatal("all digits should be weak")
	}
}

func TestIsWeakToken_Strong(t *testing.T) {
	if isWeakToken("xK9mP2vL7nQ4wR8j") {
		t.Fatal("mixed chars should not be weak")
	}
}

// ── normalizeCliApiToken ──

func TestNormalizeCliApiToken_Plain(t *testing.T) {
	got := normalizeCliApiToken("simple-token-value-no-colon", "test")
	if got != "simple-token-value-no-colon" {
		t.Fatalf("got %q", got)
	}
}

// ── getenvDefault ──

func TestGetenvDefault_Fallback(t *testing.T) {
	got := getenvDefault("HAPI_TEST_NONEXISTENT_VAR_12345", "fallback")
	if got != "fallback" {
		t.Fatalf("got %q", got)
	}
}
