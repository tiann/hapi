package push

import (
	"encoding/hex"
	"testing"
)

func TestExtractAudience(t *testing.T) {
	tests := []struct {
		endpoint string
		want     string
	}{
		{"https://fcm.googleapis.com/fcm/send/abc123", "https://fcm.googleapis.com"},
		{"https://updates.push.services.mozilla.com/wpush/v2/xyz", "https://updates.push.services.mozilla.com"},
		{"https://example.com", "https://example.com"},
		{"https://example.com/", "https://example.com"},
		{"invalid-url", "invalid-url"},
	}
	for _, tt := range tests {
		t.Run(tt.endpoint, func(t *testing.T) {
			got := extractAudience(tt.endpoint)
			if got != tt.want {
				t.Fatalf("extractAudience(%q) = %q, want %q", tt.endpoint, got, tt.want)
			}
		})
	}
}

func TestHkdfExtract(t *testing.T) {
	salt := []byte("salt-value")
	ikm := []byte("input-key-material")
	result := hkdfExtract(salt, ikm)
	if len(result) != 32 {
		t.Fatalf("hkdfExtract output length = %d, want 32", len(result))
	}
	// deterministic
	result2 := hkdfExtract(salt, ikm)
	if hex.EncodeToString(result) != hex.EncodeToString(result2) {
		t.Fatal("hkdfExtract should be deterministic")
	}
}

func TestHkdfExpand(t *testing.T) {
	prk := hkdfExtract([]byte("salt"), []byte("ikm"))
	info := []byte("info")

	out16 := hkdfExpand(prk, info, 16)
	if len(out16) != 16 {
		t.Fatalf("hkdfExpand(16) length = %d", len(out16))
	}

	out32 := hkdfExpand(prk, info, 32)
	if len(out32) != 32 {
		t.Fatalf("hkdfExpand(32) length = %d", len(out32))
	}

	// first 16 bytes should match
	if hex.EncodeToString(out16) != hex.EncodeToString(out32[:16]) {
		t.Fatal("hkdfExpand(16) should be prefix of hkdfExpand(32)")
	}

	out12 := hkdfExpand(prk, info, 12)
	if len(out12) != 12 {
		t.Fatalf("hkdfExpand(12) length = %d", len(out12))
	}
}

func TestHmacSHA256(t *testing.T) {
	result := hmacSHA256([]byte("key"), []byte("data"))
	if len(result) != 32 {
		t.Fatalf("hmacSHA256 length = %d, want 32", len(result))
	}
	// deterministic
	result2 := hmacSHA256([]byte("key"), []byte("data"))
	if hex.EncodeToString(result) != hex.EncodeToString(result2) {
		t.Fatal("hmacSHA256 should be deterministic")
	}
	// different key produces different result
	result3 := hmacSHA256([]byte("other-key"), []byte("data"))
	if hex.EncodeToString(result) == hex.EncodeToString(result3) {
		t.Fatal("different keys should produce different results")
	}
}
