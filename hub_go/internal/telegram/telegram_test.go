package telegram

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"testing"
	"time"

	"hub_go/internal/store"
)

// ── InitData Validation ──

func buildTestInitData(botToken string, user string, authDate int64) string {
	entries := map[string]string{
		"user":      user,
		"auth_date": strconv.FormatInt(authDate, 10),
	}
	dataCheckString := computeDataCheckString(entries)
	secretKey := hmacSHA256([]byte("WebAppData"), []byte(botToken))
	mac := hmac.New(sha256.New, secretKey)
	mac.Write([]byte(dataCheckString))
	hash := hex.EncodeToString(mac.Sum(nil))
	entries["hash"] = hash

	params := url.Values{}
	for k, v := range entries {
		params.Set(k, v)
	}
	return params.Encode()
}

func TestValidateInitData_Valid(t *testing.T) {
	token := "123456:ABC-DEF"
	user := `{"id":12345,"first_name":"Test"}`
	authDate := time.Now().Unix()
	initData := buildTestInitData(token, user, authDate)

	result := ValidateInitData(initData, token, 5*time.Minute)
	if !result.OK {
		t.Fatalf("expected OK, got error: %s", result.Error)
	}
	if result.User.ID != 12345 {
		t.Fatalf("User.ID = %d, want 12345", result.User.ID)
	}
	if result.User.FirstName != "Test" {
		t.Fatalf("User.FirstName = %q", result.User.FirstName)
	}
}

func TestValidateInitData_MissingHash(t *testing.T) {
	result := ValidateInitData("user=test&auth_date=123", "token", time.Hour)
	if result.OK {
		t.Fatal("should fail with missing hash")
	}
}

func TestValidateInitData_Expired(t *testing.T) {
	token := "123456:ABC-DEF"
	user := `{"id":1,"first_name":"X"}`
	oldDate := time.Now().Unix() - 3600 // 1 hour ago
	initData := buildTestInitData(token, user, oldDate)

	result := ValidateInitData(initData, token, 5*time.Minute)
	if result.OK {
		t.Fatal("should fail with expired auth_date")
	}
	if result.Error != "initData is too old" {
		t.Fatalf("Error = %q", result.Error)
	}
}

func TestValidateInitData_InvalidSignature(t *testing.T) {
	token := "123456:ABC-DEF"
	user := `{"id":1,"first_name":"X"}`
	initData := buildTestInitData(token, user, time.Now().Unix())

	result := ValidateInitData(initData, "wrong-token", 5*time.Minute)
	if result.OK {
		t.Fatal("should fail with wrong token")
	}
}

func TestValidateInitData_MissingUser(t *testing.T) {
	result := ValidateInitData(
		fmt.Sprintf("auth_date=%d&hash=abc", time.Now().Unix()),
		"token", time.Hour,
	)
	if result.OK {
		t.Fatal("should fail with missing user")
	}
}

func TestComputeDataCheckString(t *testing.T) {
	entries := map[string]string{
		"hash":      "should-be-excluded",
		"auth_date": "123",
		"user":      "test",
	}
	got := computeDataCheckString(entries)
	want := "auth_date=123\nuser=test"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestSafeCompareHex(t *testing.T) {
	if !safeCompareHex("abcd", "abcd") {
		t.Fatal("identical hex should match")
	}
	if safeCompareHex("abcd", "abce") {
		t.Fatal("different hex should not match")
	}
	if safeCompareHex("invalid", "abcd") {
		t.Fatal("invalid hex should not match")
	}
}

// ── Bot Helper Functions ──

func TestTruncate(t *testing.T) {
	tests := []struct {
		s      string
		maxLen int
		want   string
	}{
		{"short", 10, "short"},
		{"exactly10!", 10, "exactly10!"},
		{"this is longer than ten", 10, "this is..."},
		{"中文测试字符串", 5, "中文..."},
	}
	for _, tt := range tests {
		t.Run(tt.s, func(t *testing.T) {
			got := truncate(tt.s, tt.maxLen)
			if got != tt.want {
				t.Fatalf("truncate(%q, %d) = %q, want %q", tt.s, tt.maxLen, got, tt.want)
			}
		})
	}
}

func TestGetStringArg(t *testing.T) {
	args := map[string]any{
		"file_path": "/tmp/test",
		"empty":     "",
		"number":    42,
	}

	if got := getStringArg(args, "file_path"); got != "/tmp/test" {
		t.Fatalf("got %q", got)
	}
	if got := getStringArg(args, "missing", "file_path"); got != "/tmp/test" {
		t.Fatalf("fallback key not used: got %q", got)
	}
	if got := getStringArg(args, "empty"); got != "" {
		t.Fatalf("empty string should return empty: got %q", got)
	}
	if got := getStringArg(args, "number"); got != "" {
		t.Fatalf("non-string should return empty: got %q", got)
	}
	if got := getStringArg(args, "missing"); got != "" {
		t.Fatalf("missing key should return empty: got %q", got)
	}
}

func TestCreateAndParseCallbackData(t *testing.T) {
	data := createCallbackData("approve", "abcdefgh-1234-5678", "req-001")
	cb := parseCallbackData(data)
	if cb.Action != "approve" {
		t.Fatalf("Action = %q", cb.Action)
	}
	if cb.SessionPrefix != "abcdefgh" {
		t.Fatalf("SessionPrefix = %q, want abcdefgh", cb.SessionPrefix)
	}
	if cb.Extra != "req-001" {
		t.Fatalf("Extra = %q", cb.Extra)
	}
}

func TestParseCallbackData_Minimal(t *testing.T) {
	cb := parseCallbackData("deny")
	if cb.Action != "deny" {
		t.Fatalf("Action = %q", cb.Action)
	}
	if cb.SessionPrefix != "" || cb.Extra != "" {
		t.Fatalf("unexpected non-empty fields: %+v", cb)
	}
}

func TestFindSessionByPrefix(t *testing.T) {
	sessions := []store.Session{
		{ID: "abcdef01-1111-2222-3333-444444444444"},
		{ID: "bbbbbbbb-1111-2222-3333-444444444444"},
	}
	got := findSessionByPrefix(sessions, "abcdef01")
	if got == nil || got.ID != sessions[0].ID {
		t.Fatalf("findSessionByPrefix = %v", got)
	}
	got2 := findSessionByPrefix(sessions, "xxxxxxxx")
	if got2 != nil {
		t.Fatal("should return nil for no match")
	}
}

func TestBuildMiniAppDeepLink(t *testing.T) {
	tests := []struct {
		base  string
		param string
		want  string
	}{
		{"https://example.com", "session_abc", "https://example.com?startapp=session_abc"},
		{"https://example.com?foo=bar", "test", "https://example.com?foo=bar&startapp=test"},
	}
	for _, tt := range tests {
		got := buildMiniAppDeepLink(tt.base, tt.param)
		if got != tt.want {
			t.Fatalf("buildMiniAppDeepLink(%q, %q) = %q, want %q", tt.base, tt.param, got, tt.want)
		}
	}
}
