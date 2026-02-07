package store

import (
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	if err != nil {
		t.Fatalf("Open(:memory:) failed: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// ── Sessions ──

func TestCreateAndGetSession(t *testing.T) {
	s := newTestStore(t)
	meta := map[string]any{"title": "test session"}
	sess, err := s.CreateSession("ns1", meta, nil)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	if sess == nil {
		t.Fatal("CreateSession returned nil")
	}
	if sess.Namespace != "ns1" {
		t.Fatalf("Namespace = %q, want ns1", sess.Namespace)
	}
	if sess.Metadata["title"] != "test session" {
		t.Fatalf("Metadata.title = %v, want 'test session'", sess.Metadata["title"])
	}

	got, err := s.GetSession("ns1", sess.ID)
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got == nil || got.ID != sess.ID {
		t.Fatalf("GetSession returned %v, want id=%s", got, sess.ID)
	}
}

func TestCreateSessionWithID(t *testing.T) {
	s := newTestStore(t)
	sess, err := s.CreateSessionWithID("ns1", "fixed-id", nil, nil)
	if err != nil {
		t.Fatalf("CreateSessionWithID: %v", err)
	}
	if sess.ID != "fixed-id" {
		t.Fatalf("ID = %q, want fixed-id", sess.ID)
	}
}

func TestCreateSessionWithID_Duplicate(t *testing.T) {
	s := newTestStore(t)
	_, err := s.CreateSessionWithID("ns1", "dup-id", nil, nil)
	if err != nil {
		t.Fatalf("first CreateSessionWithID: %v", err)
	}
	// INSERT OR IGNORE should not error
	sess2, err := s.CreateSessionWithID("ns1", "dup-id", map[string]any{"new": true}, nil)
	if err != nil {
		t.Fatalf("duplicate CreateSessionWithID: %v", err)
	}
	// original metadata should be preserved (INSERT OR IGNORE)
	if sess2.Metadata != nil && sess2.Metadata["new"] == true {
		t.Fatal("duplicate insert should not overwrite metadata")
	}
}

func TestGetSession_NotFound(t *testing.T) {
	s := newTestStore(t)
	got, err := s.GetSession("ns1", "nonexistent")
	if err != nil {
		t.Fatalf("GetSession: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %v", got)
	}
}

func TestSessionExists(t *testing.T) {
	s := newTestStore(t)
	if s.SessionExists("nope") {
		t.Fatal("SessionExists should return false for nonexistent")
	}
	sess, _ := s.CreateSession("ns1", nil, nil)
	if !s.SessionExists(sess.ID) {
		t.Fatal("SessionExists should return true after create")
	}
}

func TestListSessions(t *testing.T) {
	s := newTestStore(t)
	s.CreateSession("ns1", map[string]any{"i": 1}, nil)
	s.CreateSession("ns1", map[string]any{"i": 2}, nil)
	s.CreateSession("ns2", map[string]any{"i": 3}, nil)

	list := s.ListSessions("ns1")
	if len(list) != 2 {
		t.Fatalf("ListSessions(ns1) = %d, want 2", len(list))
	}
	list2 := s.ListSessions("ns2")
	if len(list2) != 1 {
		t.Fatalf("ListSessions(ns2) = %d, want 1", len(list2))
	}
	empty := s.ListSessions("noexist")
	if len(empty) != 0 {
		t.Fatalf("ListSessions(noexist) = %d, want 0", len(empty))
	}
}

func TestUpdateSession(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.CreateSession("ns1", map[string]any{"title": "old"}, nil)
	sess.Metadata = map[string]any{"title": "new"}
	sess.Active = true
	sess.Thinking = true
	sess.PermissionMode = "auto"
	sess.ModelMode = "gpt4"
	if err := s.UpdateSession("ns1", sess); err != nil {
		t.Fatalf("UpdateSession: %v", err)
	}
	got, _ := s.GetSession("ns1", sess.ID)
	if got.Metadata["title"] != "new" {
		t.Fatalf("Metadata.title = %v, want 'new'", got.Metadata["title"])
	}
	if !got.Active {
		t.Fatal("Active should be true")
	}
	if !got.Thinking {
		t.Fatal("Thinking should be true")
	}
	if got.PermissionMode != "auto" {
		t.Fatalf("PermissionMode = %q, want auto", got.PermissionMode)
	}
	if got.ModelMode != "gpt4" {
		t.Fatalf("ModelMode = %q, want gpt4", got.ModelMode)
	}
}

func TestUpdateSessionMetadata_VersionMismatch(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.CreateSession("ns1", map[string]any{"k": "v1"}, nil)

	result, err := s.UpdateSessionMetadata("ns1", sess.ID, map[string]any{"k": "v2"}, 999)
	if err != nil {
		t.Fatalf("UpdateSessionMetadata: %v", err)
	}
	if result.Result != "version-mismatch" {
		t.Fatalf("Result = %q, want version-mismatch", result.Result)
	}
}

func TestUpdateSessionMetadata_Success(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.CreateSession("ns1", map[string]any{"k": "v1"}, nil)

	result, err := s.UpdateSessionMetadata("ns1", sess.ID, map[string]any{"k": "v2"}, sess.MetadataVersion)
	if err != nil {
		t.Fatalf("UpdateSessionMetadata: %v", err)
	}
	if result.Result != "success" {
		t.Fatalf("Result = %q, want success", result.Result)
	}
	if result.Version != sess.MetadataVersion+1 {
		t.Fatalf("Version = %d, want %d", result.Version, sess.MetadataVersion+1)
	}
}

func TestUpdateSessionAgentState_VersionMismatch(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.CreateSession("ns1", nil, map[string]any{"state": "init"})

	result, _ := s.UpdateSessionAgentState("ns1", sess.ID, map[string]any{"state": "running"}, 999)
	if result.Result != "version-mismatch" {
		t.Fatalf("Result = %q, want version-mismatch", result.Result)
	}
}

func TestSetSessionTodos(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.CreateSession("ns1", nil, nil)

	todos := []map[string]any{{"text": "do stuff", "done": false}}
	ok := s.SetSessionTodos("ns1", sess.ID, todos, 1000)
	if !ok {
		t.Fatal("SetSessionTodos should return true")
	}

	got, _ := s.GetSession("ns1", sess.ID)
	if got.TodosUpdatedAt != 1000 {
		t.Fatalf("TodosUpdatedAt = %d, want 1000", got.TodosUpdatedAt)
	}

	// older timestamp should be rejected
	ok2 := s.SetSessionTodos("ns1", sess.ID, todos, 500)
	if ok2 {
		t.Fatal("SetSessionTodos with older timestamp should return false")
	}
}

func TestGetSessionByTag(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.CreateSessionWithID("ns1", "tagged-id", nil, nil)
	sess.Tag = "my-tag"
	s.UpdateSession("ns1", sess)

	got, err := s.GetSessionByTag("ns1", "my-tag")
	if err != nil {
		t.Fatalf("GetSessionByTag: %v", err)
	}
	if got == nil || got.ID != "tagged-id" {
		t.Fatalf("GetSessionByTag = %v, want tagged-id", got)
	}

	// empty tag returns nil
	got2, _ := s.GetSessionByTag("ns1", "")
	if got2 != nil {
		t.Fatal("empty tag should return nil")
	}
}

func TestDeleteSession(t *testing.T) {
	s := newTestStore(t)
	sess, _ := s.CreateSession("ns1", nil, nil)
	if !s.DeleteSession("ns1", sess.ID) {
		t.Fatal("DeleteSession should return true")
	}
	if s.SessionExists(sess.ID) {
		t.Fatal("session should not exist after delete")
	}
	if s.DeleteSession("ns1", "nonexistent") {
		t.Fatal("DeleteSession of nonexistent should return false")
	}
}

// ── Machines ──

func TestUpsertAndGetMachine(t *testing.T) {
	s := newTestStore(t)
	meta := map[string]any{"hostname": "dev-box"}
	m, err := s.UpsertMachine("ns1", "m1", meta, nil)
	if err != nil {
		t.Fatalf("UpsertMachine: %v", err)
	}
	if m == nil || m.ID != "m1" {
		t.Fatalf("UpsertMachine returned %v", m)
	}

	got, err := s.GetMachine("ns1", "m1")
	if err != nil {
		t.Fatalf("GetMachine: %v", err)
	}
	if got == nil || got.ID != "m1" {
		t.Fatalf("GetMachine = %v, want m1", got)
	}
}

func TestUpsertMachine_Update(t *testing.T) {
	s := newTestStore(t)
	s.UpsertMachine("ns1", "m1", map[string]any{"v": 1}, nil)
	m2, _ := s.UpsertMachine("ns1", "m1", map[string]any{"v": 2}, nil)
	if m2.MetadataVersion != 2 {
		t.Fatalf("MetadataVersion = %d, want 2", m2.MetadataVersion)
	}
}

func TestUpsertMachine_EmptyID(t *testing.T) {
	s := newTestStore(t)
	m, err := s.UpsertMachine("ns1", "", nil, nil)
	if err != nil || m != nil {
		t.Fatalf("empty ID should return (nil, nil), got (%v, %v)", m, err)
	}
}

func TestMachineExists(t *testing.T) {
	s := newTestStore(t)
	if s.MachineExists("nope") {
		t.Fatal("MachineExists should be false for nonexistent")
	}
	s.UpsertMachine("ns1", "m1", nil, nil)
	if !s.MachineExists("m1") {
		t.Fatal("MachineExists should be true after upsert")
	}
}

func TestListMachines(t *testing.T) {
	s := newTestStore(t)
	s.UpsertMachine("ns1", "m1", nil, nil)
	s.UpsertMachine("ns1", "m2", nil, nil)
	s.UpsertMachine("ns2", "m3", nil, nil)

	list := s.ListMachines("ns1")
	if len(list) != 2 {
		t.Fatalf("ListMachines(ns1) = %d, want 2", len(list))
	}
}

func TestUpdateMachineMetadata_VersionMismatch(t *testing.T) {
	s := newTestStore(t)
	s.UpsertMachine("ns1", "m1", map[string]any{"k": "v"}, nil)

	result, _ := s.UpdateMachineMetadata("ns1", "m1", map[string]any{"k": "v2"}, 999)
	if result.Result != "version-mismatch" {
		t.Fatalf("Result = %q, want version-mismatch", result.Result)
	}
}

func TestUpdateMachineRunnerState_Success(t *testing.T) {
	s := newTestStore(t)
	m, _ := s.UpsertMachine("ns1", "m1", nil, map[string]any{"status": "idle"})

	result, err := s.UpdateMachineRunnerState("ns1", "m1", map[string]any{"status": "busy"}, m.RunnerStateVersion)
	if err != nil {
		t.Fatalf("UpdateMachineRunnerState: %v", err)
	}
	if result.Result != "success" {
		t.Fatalf("Result = %q, want success", result.Result)
	}
}

// ── Messages ──

func TestAddAndListMessages(t *testing.T) {
	s := newTestStore(t)
	s.CreateSessionWithID("ns1", "s1", nil, nil)

	msg1 := s.AddMessage("s1", map[string]any{"text": "hello"}, "")
	msg2 := s.AddMessage("s1", map[string]any{"text": "world"}, "local-1")

	if msg1.Seq != 1 {
		t.Fatalf("msg1.Seq = %d, want 1", msg1.Seq)
	}
	if msg2.Seq != 2 {
		t.Fatalf("msg2.Seq = %d, want 2", msg2.Seq)
	}
	if msg2.LocalID != "local-1" {
		t.Fatalf("msg2.LocalID = %q, want local-1", msg2.LocalID)
	}

	// ListMessages returns in ASC order
	messages := s.ListMessages("s1", 0, 100)
	if len(messages) != 2 {
		t.Fatalf("ListMessages = %d, want 2", len(messages))
	}
	if messages[0].Seq != 1 || messages[1].Seq != 2 {
		t.Fatalf("messages not in ASC seq order: %d, %d", messages[0].Seq, messages[1].Seq)
	}
}

func TestListMessages_BeforeSeq(t *testing.T) {
	s := newTestStore(t)
	s.CreateSessionWithID("ns1", "s1", nil, nil)
	s.AddMessage("s1", "a", "")
	s.AddMessage("s1", "b", "")
	s.AddMessage("s1", "c", "")

	messages := s.ListMessages("s1", 3, 10)
	if len(messages) != 2 {
		t.Fatalf("ListMessages(beforeSeq=3) = %d, want 2", len(messages))
	}
}

func TestListMessages_Limit(t *testing.T) {
	s := newTestStore(t)
	s.CreateSessionWithID("ns1", "s1", nil, nil)
	for i := 0; i < 5; i++ {
		s.AddMessage("s1", i, "")
	}

	messages := s.ListMessages("s1", 0, 2)
	// limit=2 returns the last 2 messages (DESC then reversed)
	if len(messages) != 2 {
		t.Fatalf("ListMessages(limit=2) = %d, want 2", len(messages))
	}
}

func TestListMessagesAfter(t *testing.T) {
	s := newTestStore(t)
	s.CreateSessionWithID("ns1", "s1", nil, nil)
	s.AddMessage("s1", "a", "")
	s.AddMessage("s1", "b", "")
	s.AddMessage("s1", "c", "")

	messages := s.ListMessagesAfter("s1", 1, 10)
	if len(messages) != 2 {
		t.Fatalf("ListMessagesAfter(1) = %d, want 2", len(messages))
	}
	if messages[0].Seq != 2 {
		t.Fatalf("first message seq = %d, want 2", messages[0].Seq)
	}
}

func TestAddMessage_UpdatesSessionSeq(t *testing.T) {
	s := newTestStore(t)
	s.CreateSessionWithID("ns1", "s1", nil, nil)
	s.AddMessage("s1", "hello", "")

	sess, _ := s.GetSession("ns1", "s1")
	if sess.Seq != 1 {
		t.Fatalf("session.Seq = %d after AddMessage, want 1", sess.Seq)
	}
}

// ── Users ──

func TestAddAndGetUser(t *testing.T) {
	s := newTestStore(t)
	user, err := s.AddUser("telegram", "12345", "ns1")
	if err != nil {
		t.Fatalf("AddUser: %v", err)
	}
	if user == nil || user.PlatformUserID != "12345" {
		t.Fatalf("AddUser returned %v", user)
	}

	got, err := s.GetUser("telegram", "12345")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got == nil || got.Namespace != "ns1" {
		t.Fatalf("GetUser = %v", got)
	}
}

func TestAddUser_Duplicate(t *testing.T) {
	s := newTestStore(t)
	s.AddUser("telegram", "12345", "ns1")
	// INSERT OR IGNORE - should not error, returns existing
	user2, err := s.AddUser("telegram", "12345", "ns2")
	if err != nil {
		t.Fatalf("duplicate AddUser: %v", err)
	}
	// namespace should remain ns1 (INSERT OR IGNORE)
	if user2.Namespace != "ns1" {
		t.Fatalf("Namespace = %q, want ns1 (original)", user2.Namespace)
	}
}

func TestGetUser_NotFound(t *testing.T) {
	s := newTestStore(t)
	got, err := s.GetUser("telegram", "nonexistent")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil, got %v", got)
	}
}

func TestGetUsersByPlatformAndNamespace(t *testing.T) {
	s := newTestStore(t)
	s.AddUser("telegram", "u1", "ns1")
	s.AddUser("telegram", "u2", "ns1")
	s.AddUser("telegram", "u3", "ns2")
	s.AddUser("web", "u4", "ns1")

	users := s.GetUsersByPlatformAndNamespace("telegram", "ns1")
	if len(users) != 2 {
		t.Fatalf("got %d users, want 2", len(users))
	}
}

// ── Push Subscriptions ──

func TestUpsertAndGetPushSubscription(t *testing.T) {
	s := newTestStore(t)
	err := s.UpsertPushSubscription("ns1", "https://push.example.com/1", "p256dh-key", "auth-secret")
	if err != nil {
		t.Fatalf("UpsertPushSubscription: %v", err)
	}

	subs := s.GetPushSubscriptionsByNamespace("ns1")
	if len(subs) != 1 {
		t.Fatalf("got %d subs, want 1", len(subs))
	}
	if subs[0].Endpoint != "https://push.example.com/1" {
		t.Fatalf("Endpoint = %q", subs[0].Endpoint)
	}
}

func TestUpsertPushSubscription_Update(t *testing.T) {
	s := newTestStore(t)
	s.UpsertPushSubscription("ns1", "https://push.example.com/1", "old-key", "old-auth")
	s.UpsertPushSubscription("ns1", "https://push.example.com/1", "new-key", "new-auth")

	subs := s.GetPushSubscriptionsByNamespace("ns1")
	if len(subs) != 1 {
		t.Fatalf("got %d subs after upsert, want 1", len(subs))
	}
	if subs[0].P256dh != "new-key" {
		t.Fatalf("P256dh = %q, want new-key", subs[0].P256dh)
	}
}

func TestDeletePushSubscription(t *testing.T) {
	s := newTestStore(t)
	s.UpsertPushSubscription("ns1", "https://push.example.com/1", "k", "a")
	err := s.DeletePushSubscription("ns1", "https://push.example.com/1")
	if err != nil {
		t.Fatalf("DeletePushSubscription: %v", err)
	}
	subs := s.GetPushSubscriptionsByNamespace("ns1")
	if len(subs) != 0 {
		t.Fatalf("got %d subs after delete, want 0", len(subs))
	}
}

// ── Store Open/Close ──

func TestOpen_InvalidPath(t *testing.T) {
	_, err := Open("/nonexistent/path/that/should/fail/db.sqlite")
	if err == nil {
		t.Fatal("Open with invalid path should fail")
	}
}

func TestClose_NilStore(t *testing.T) {
	var s *Store
	if err := s.Close(); err != nil {
		t.Fatalf("Close on nil store should not error: %v", err)
	}
}
