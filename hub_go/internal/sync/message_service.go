package sync

import "hub_go/internal/store"

type MessagesPage struct {
	Messages []store.Message
	Page     PageInfo
}

type PageInfo struct {
	Limit         int
	BeforeSeq     int64
	NextBeforeSeq int64
	HasMore       bool
}

type MessageService struct {
	store *store.Store
}

func NewMessageService(store *store.Store) *MessageService {
	return &MessageService{store: store}
}

func (m *MessageService) GetMessagesPage(sessionID string, limit int, beforeSeq int64) MessagesPage {
	if m == nil || m.store == nil {
		return MessagesPage{}
	}
	messages := m.store.ListMessages(sessionID, beforeSeq, limit)
	oldestSeq := int64(0)
	for _, msg := range messages {
		if oldestSeq == 0 || msg.Seq < oldestSeq {
			oldestSeq = msg.Seq
		}
	}
	nextBeforeSeq := int64(0)
	hasMore := false
	if oldestSeq > 0 {
		nextBeforeSeq = oldestSeq
		hasMore = len(m.store.ListMessages(sessionID, oldestSeq, 1)) > 0
	}

	page := PageInfo{
		Limit:         limit,
		BeforeSeq:     beforeSeq,
		NextBeforeSeq: nextBeforeSeq,
		HasMore:       hasMore,
	}
	return MessagesPage{Messages: messages, Page: page}
}

func (m *MessageService) GetMessagesAfter(sessionID string, limit int, afterSeq int64) []store.Message {
	if m == nil || m.store == nil {
		return nil
	}
	return m.store.ListMessagesAfter(sessionID, afterSeq, limit)
}
