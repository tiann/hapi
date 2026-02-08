package push

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"hub_go/internal/config"
	"hub_go/internal/store"
)

func generateTestVapidKeys(t *testing.T) *config.VapidKeys {
	t.Helper()
	curve := elliptic.P256()
	privKey, err := ecdsa.GenerateKey(curve, rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	privBytes := privKey.D.Bytes()
	// Pad to 32 bytes
	for len(privBytes) < 32 {
		privBytes = append([]byte{0}, privBytes...)
	}
	pubBytes := elliptic.MarshalCompressed(curve, privKey.PublicKey.X, privKey.PublicKey.Y)
	return &config.VapidKeys{
		PublicKey:  base64.RawURLEncoding.EncodeToString(pubBytes),
		PrivateKey: base64.RawURLEncoding.EncodeToString(privBytes),
	}
}

func TestNewService_Valid(t *testing.T) {
	keys := generateTestVapidKeys(t)
	svc, err := NewService(keys, "mailto:test@example.com", nil)
	if err != nil {
		t.Fatalf("NewService error: %v", err)
	}
	if svc == nil {
		t.Fatal("service is nil")
	}
	if svc.subject != "mailto:test@example.com" {
		t.Fatalf("subject = %q, want mailto:test@example.com", svc.subject)
	}
}

func TestNewService_NilKeys(t *testing.T) {
	_, err := NewService(nil, "mailto:test@example.com", nil)
	if err == nil {
		t.Fatal("expected error for nil keys")
	}
}

func TestNewService_EmptyPublicKey(t *testing.T) {
	keys := &config.VapidKeys{PublicKey: "", PrivateKey: "some-key"}
	_, err := NewService(keys, "mailto:test@example.com", nil)
	if err == nil {
		t.Fatal("expected error for empty public key")
	}
}

func TestNewService_EmptyPrivateKey(t *testing.T) {
	keys := &config.VapidKeys{PublicKey: "some-key", PrivateKey: ""}
	_, err := NewService(keys, "mailto:test@example.com", nil)
	if err == nil {
		t.Fatal("expected error for empty private key")
	}
}

func TestNewService_InvalidBase64(t *testing.T) {
	keys := &config.VapidKeys{PublicKey: "valid", PrivateKey: "!!!invalid-base64!!!"}
	_, err := NewService(keys, "mailto:test@example.com", nil)
	if err == nil {
		t.Fatal("expected error for invalid base64")
	}
}

func TestCreateVAPIDHeader(t *testing.T) {
	keys := generateTestVapidKeys(t)
	svc, err := NewService(keys, "mailto:test@example.com", nil)
	if err != nil {
		t.Fatalf("NewService error: %v", err)
	}

	header, err := svc.createVAPIDHeader("https://fcm.googleapis.com/fcm/send/abc")
	if err != nil {
		t.Fatalf("createVAPIDHeader error: %v", err)
	}

	if !strings.HasPrefix(header, "vapid t=") {
		t.Fatalf("header should start with 'vapid t=', got %q", header)
	}
	if !strings.Contains(header, ", k=") {
		t.Fatalf("header should contain ', k=', got %q", header)
	}
	// Should contain the public key
	if !strings.Contains(header, keys.PublicKey) {
		t.Fatal("header should contain the public key")
	}
}

func TestEncryptPayload(t *testing.T) {
	keys := generateTestVapidKeys(t)
	svc, err := NewService(keys, "mailto:test@example.com", nil)
	if err != nil {
		t.Fatalf("NewService error: %v", err)
	}

	// Generate subscriber key pair
	subscriberPriv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	subscriberPub := subscriberPriv.PublicKey()

	authSecret := make([]byte, 16)
	if _, err := rand.Read(authSecret); err != nil {
		t.Fatal(err)
	}

	sub := store.PushSubscription{
		Endpoint: "https://fcm.googleapis.com/fcm/send/abc",
		P256dh:   base64.RawURLEncoding.EncodeToString(subscriberPub.Bytes()),
		Auth:     base64.RawURLEncoding.EncodeToString(authSecret),
	}

	payload := []byte(`{"title":"test","body":"hello"}`)
	encrypted, err := svc.encryptPayload(sub, payload)
	if err != nil {
		t.Fatalf("encryptPayload error: %v", err)
	}

	// Verify minimum header size: salt(16) + recordSize(4) + keyLen(1) + key(65) = 86
	if len(encrypted) < 86 {
		t.Fatalf("encrypted payload too short: %d bytes", len(encrypted))
	}

	// Verify salt is 16 bytes
	salt := encrypted[:16]
	if len(salt) != 16 {
		t.Fatal("salt should be 16 bytes")
	}

	// Verify key length byte
	keyLen := int(encrypted[20])
	if keyLen != 65 {
		t.Fatalf("key length = %d, want 65 (uncompressed P-256 point)", keyLen)
	}

	// Verify non-deterministic (random salt + ephemeral key)
	encrypted2, err := svc.encryptPayload(sub, payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(encrypted) == string(encrypted2) {
		t.Fatal("encryption should be non-deterministic")
	}
}

func TestEncryptPayload_InvalidP256dh(t *testing.T) {
	keys := generateTestVapidKeys(t)
	svc, err := NewService(keys, "mailto:test@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}

	sub := store.PushSubscription{
		Endpoint: "https://example.com/push",
		P256dh:   base64.RawURLEncoding.EncodeToString([]byte("too-short")),
		Auth:     base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
	}

	_, err = svc.encryptPayload(sub, []byte("test"))
	if err == nil {
		t.Fatal("expected error for invalid P256dh")
	}
}

func TestSendToNamespace_NilService(t *testing.T) {
	var svc *Service
	err := svc.SendToNamespace("test-ns", PushPayload{Title: "test"})
	if err != nil {
		t.Fatalf("nil service SendToNamespace error: %v", err)
	}
}

func TestSendToSubscription_NonHTTPS(t *testing.T) {
	keys := generateTestVapidKeys(t)
	svc, err := NewService(keys, "mailto:test@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}

	sub := store.PushSubscription{
		Endpoint: "http://insecure.example.com/push",
		P256dh:   "test",
		Auth:     "test",
	}

	err = svc.sendToSubscription("ns", sub, []byte("test"))
	if err == nil {
		t.Fatal("expected error for non-HTTPS endpoint")
	}
	if !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("error should mention HTTPS: %v", err)
	}
}

func TestSendToSubscription_Gone(t *testing.T) {
	// Create a mock HTTPS server that returns 410 Gone
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusGone)
	}))
	defer server.Close()

	// Need a real store for DeletePushSubscription call
	tmpDB := t.TempDir() + "/test.db"
	st, err := store.Open(tmpDB)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer st.Close()

	keys := generateTestVapidKeys(t)
	svc, err := NewService(keys, "mailto:test@example.com", st)
	if err != nil {
		t.Fatal(err)
	}
	// Use TLS client from test server
	svc.httpClient = server.Client()

	// Generate valid subscriber keys
	subscriberPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	authSecret := make([]byte, 16)
	rand.Read(authSecret)

	sub := store.PushSubscription{
		Endpoint: server.URL + "/push",
		P256dh:   base64.RawURLEncoding.EncodeToString(subscriberPriv.PublicKey().Bytes()),
		Auth:     base64.RawURLEncoding.EncodeToString(authSecret),
	}

	// Since endpoint is not HTTPS (it's the test server URL which starts with https),
	// we need to adjust - httptest.NewTLSServer URL starts with https://
	err = svc.sendToSubscription("ns", sub, []byte(`{"title":"test"}`))
	// Should not return error - 410 is handled gracefully
	if err != nil {
		t.Fatalf("410 Gone should not return error: %v", err)
	}
}

func TestSendToSubscription_ServerError(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("server error"))
	}))
	defer server.Close()

	keys := generateTestVapidKeys(t)
	svc, err := NewService(keys, "mailto:test@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc.httpClient = server.Client()

	subscriberPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	authSecret := make([]byte, 16)
	rand.Read(authSecret)

	sub := store.PushSubscription{
		Endpoint: server.URL + "/push",
		P256dh:   base64.RawURLEncoding.EncodeToString(subscriberPriv.PublicKey().Bytes()),
		Auth:     base64.RawURLEncoding.EncodeToString(authSecret),
	}

	err = svc.sendToSubscription("ns", sub, []byte(`{"title":"test"}`))
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
	if !strings.Contains(err.Error(), "500") {
		t.Fatalf("error should contain status code: %v", err)
	}
}

func TestSendToSubscription_Success(t *testing.T) {
	var receivedAuth string
	var receivedEncoding string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedAuth = r.Header.Get("Authorization")
		receivedEncoding = r.Header.Get("Content-Encoding")
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	keys := generateTestVapidKeys(t)
	svc, err := NewService(keys, "mailto:test@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	svc.httpClient = server.Client()

	subscriberPriv, _ := ecdh.P256().GenerateKey(rand.Reader)
	authSecret := make([]byte, 16)
	rand.Read(authSecret)

	sub := store.PushSubscription{
		Endpoint: server.URL + "/push",
		P256dh:   base64.RawURLEncoding.EncodeToString(subscriberPriv.PublicKey().Bytes()),
		Auth:     base64.RawURLEncoding.EncodeToString(authSecret),
	}

	err = svc.sendToSubscription("ns", sub, []byte(`{"title":"test"}`))
	if err != nil {
		t.Fatalf("success case error: %v", err)
	}

	if !strings.HasPrefix(receivedAuth, "vapid t=") {
		t.Fatalf("Authorization header = %q, want vapid prefix", receivedAuth)
	}
	if receivedEncoding != "aes128gcm" {
		t.Fatalf("Content-Encoding = %q, want aes128gcm", receivedEncoding)
	}
}

// Helper to use for test VAPID private key to ecdsa.PrivateKey conversion
func testVapidPrivateKeyToECDSA(privKeyB64 string) (*ecdsa.PrivateKey, error) {
	privBytes, err := base64.RawURLEncoding.DecodeString(privKeyB64)
	if err != nil {
		return nil, err
	}
	curve := elliptic.P256()
	x, y := curve.ScalarBaseMult(privBytes)
	key := &ecdsa.PrivateKey{
		PublicKey: ecdsa.PublicKey{
			Curve: curve,
			X:     x,
			Y:     y,
		},
	}
	key.D = new(big.Int).SetBytes(privBytes)
	return key, nil
}
