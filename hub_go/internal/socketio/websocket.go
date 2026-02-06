package socketio

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

type wsConn struct {
	conn      net.Conn
	namespace string
	sessionID string
	machineID string
	engineID  string
	mu        sync.Mutex
	lastPong  time.Time
	done      chan struct{}
}

func (c *wsConn) writeText(payload string) error {
	if c == nil || c.conn == nil {
		return errors.New("conn closed")
	}
	frame := encodeTextFrame(payload)
	c.mu.Lock()
	defer c.mu.Unlock()
	_, err := c.conn.Write(frame)
	return err
}

func (s *Server) handleWebsocket(w http.ResponseWriter, req *http.Request) {
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "Hijack unsupported", http.StatusInternalServerError)
		return
	}
	conn, buf, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer conn.Close()

	if !isWebsocketUpgrade(req) {
		_, _ = conn.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n"))
		return
	}

	key := req.Header.Get("Sec-WebSocket-Key")
	if key == "" {
		_, _ = conn.Write([]byte("HTTP/1.1 400 Bad Request\r\n\r\n"))
		return
	}

	accept := computeWebsocketAccept(key)
	response := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	_, _ = conn.Write([]byte(response))

	sid := req.URL.Query().Get("sid")
	engineID := sid
	if sid == "" {
		sid = s.newSID()
		engineID = sid
		openPayload := OpenPayload{
			SID:          sid,
			Upgrades:     []string{},
			PingInterval: 25000,
			PingTimeout:  20000,
		}
		raw := mustJSON(openPayload)
		_ = writeWebsocketPacket(conn, string(EngineOpen)+raw)
	}

	ws := &wsConn{
		conn:      conn,
		namespace: "/",
		sessionID: "",
		machineID: "",
		engineID:  engineID,
		lastPong:  time.Now(),
		done:      make(chan struct{}),
	}
	go s.startPingLoop(ws)

	reader := bufio.NewReader(conn)
	if buf != nil && buf.Reader != nil {
		reader = buf.Reader
	}
	writer := bufio.NewWriter(conn)
	if buf != nil && buf.Writer != nil {
		writer = buf.Writer
	}
	for {
		op, payload, err := readWebsocketFrame(reader)
		if err != nil {
			close(ws.done)
			return
		}
		switch op {
		case 0x8:
			s.unregisterRpcConn(ws)
			close(ws.done)
			_ = writeWebsocketClose(conn)
			return
		case 0x9:
			_ = writeWebsocketPong(conn, payload)
			continue
		case 0xA:
			ws.lastPong = time.Now()
			continue
		case 0x1:
			s.handleWebsocketPacket(ws, string(payload))
		default:
			continue
		}
		_ = writer.Flush()
	}
}

func (s *Server) handleWebsocketPacket(ws *wsConn, packet string) {
	if packet == "" {
		return
	}
	parts := parseEnginePayload(packet)
	for _, part := range parts {
		if part == "" {
			continue
		}
		switch part[0] {
		case byte(EnginePing):
			if part == "2probe" {
				_ = ws.writeText("3probe")
				ws.lastPong = time.Now()
				continue
			}
			_ = ws.writeText(string(EnginePong))
			ws.lastPong = time.Now()
		case byte(EnginePong):
			ws.lastPong = time.Now()
		case byte(EngineUpgrade):
			continue
		case byte(EngineMessage):
			s.handleSocketPacketWS(ws, part[1:])
		case byte(EngineClose):
			_ = ws.writeText(string(EngineClose))
		case byte(EngineNoop):
			continue
		}
	}
}

func (s *Server) handleSocketPacketWS(ws *wsConn, raw string) {
	msg := parseSocketMessage(raw)
	if msg == nil {
		return
	}

	switch msg.Type {
	case SocketConnect:
		sessionID, machineID, err := s.validateConnect(msg.Namespace, msg.Data)
		if err != nil {
			_ = ws.writeText(string(EngineMessage) + encodeSocketError(msg.Namespace, err.Error()))
			return
		}
		ws.namespace = msg.Namespace
		ws.sessionID = sessionID
		ws.machineID = machineID
		s.registerWSConn(msg.Namespace, ws)
		s.trackNamespace(ws.engineID, msg.Namespace)
		_ = ws.writeText(string(EngineMessage) + encodeSocketConnect(msg.Namespace))
	case SocketDisconnect:
		s.unregisterRpcConn(ws)
		s.unregisterWSConn(msg.Namespace, ws)
		s.untrackNamespace(ws.engineID, msg.Namespace)
	case SocketEvent:
		ackID, trimmed := parseSocketAckID(msg.Data)
		if eventName, eventPayload, ok := parseSocketEventPayload(trimmed); ok {
			ackPayload, hasAck := s.handleEventWS(ws, msg.Namespace, eventName, eventPayload)
			if ackID != "" {
				if hasAck {
					_ = ws.writeText(string(EngineMessage) + encodeSocketAckWithIDPayload(msg.Namespace, ackID, ackPayload))
				} else {
					_ = ws.writeText(string(EngineMessage) + encodeSocketAckWithID(msg.Namespace, ackID))
				}
				return
			}
		}
		_ = ws.writeText(string(EngineMessage) + encodeSocketAck(msg.Namespace))
	case SocketAck:
		ackID, trimmed := parseSocketAckID(msg.Data)
		if ackID != "" {
			s.resolveAck(ackID, trimmed)
		}
	}
}

func (s *Server) startPingLoop(ws *wsConn) {
	if ws == nil {
		return
	}
	ticker := time.NewTicker(time.Duration(enginePingIntervalMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ws.done:
			return
		case <-ticker.C:
			if time.Since(ws.lastPong) > time.Duration(enginePingTimeoutMs)*time.Millisecond {
				_ = ws.writeText(string(EngineClose))
				return
			}
			_ = ws.writeText(string(EnginePing))
		}
	}
}

func (s *Server) registerWSConn(namespace string, ws *wsConn) {
	if s == nil || ws == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.wsConns[namespace]; !ok {
		s.wsConns[namespace] = make(map[*wsConn]struct{})
	}
	s.wsConns[namespace][ws] = struct{}{}
}

func (s *Server) unregisterWSConn(namespace string, ws *wsConn) {
	if s == nil || ws == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if conns, ok := s.wsConns[namespace]; ok {
		delete(conns, ws)
		if len(conns) == 0 {
			delete(s.wsConns, namespace)
		}
	}
}

func (s *Server) broadcastWS(namespace string, payload string, sessionID string, machineID string) {
	if s == nil || payload == "" {
		return
	}
	s.mu.RLock()
	conns := s.wsConns[namespace]
	for ws := range conns {
		if sessionID != "" && ws.sessionID != sessionID {
			continue
		}
		if machineID != "" && ws.machineID != machineID {
			continue
		}
		_ = ws.writeText(payload)
	}
	s.mu.RUnlock()
}

func isWebsocketUpgrade(req *http.Request) bool {
	if req == nil {
		return false
	}
	upgrade := strings.ToLower(req.Header.Get("Upgrade"))
	connection := strings.ToLower(req.Header.Get("Connection"))
	return upgrade == "websocket" && strings.Contains(connection, "upgrade")
}

func computeWebsocketAccept(key string) string {
	h := sha1.New()
	_, _ = h.Write([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

func encodeTextFrame(payload string) []byte {
	data := []byte(payload)
	length := len(data)
	var buf bytes.Buffer
	buf.WriteByte(0x81)
	switch {
	case length <= 125:
		buf.WriteByte(byte(length))
	case length <= 65535:
		buf.WriteByte(126)
		_ = binary.Write(&buf, binary.BigEndian, uint16(length))
	default:
		buf.WriteByte(127)
		_ = binary.Write(&buf, binary.BigEndian, uint64(length))
	}
	buf.Write(data)
	return buf.Bytes()
}

func readWebsocketFrame(r *bufio.Reader) (byte, []byte, error) {
	var header [2]byte
	if _, err := io.ReadFull(r, header[:]); err != nil {
		return 0, nil, err
	}
	opcode := header[0] & 0x0F
	masked := (header[1] & 0x80) != 0
	length := int(header[1] & 0x7F)

	switch length {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		length = int(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		length64 := binary.BigEndian.Uint64(ext[:])
		if length64 > 1<<31 {
			return 0, nil, errors.New("frame too large")
		}
		length = int(length64)
	}

	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(r, maskKey[:]); err != nil {
			return 0, nil, err
		}
	}

	payload := make([]byte, length)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return opcode, payload, nil
}

func writeWebsocketPacket(conn net.Conn, packet string) error {
	if conn == nil {
		return errors.New("conn closed")
	}
	frame := encodeTextFrame(packet)
	_, err := conn.Write(frame)
	return err
}

func writeWebsocketClose(conn net.Conn) error {
	if conn == nil {
		return nil
	}
	_, err := conn.Write([]byte{0x88, 0x00})
	return err
}

func writeWebsocketPong(conn net.Conn, payload []byte) error {
	if conn == nil {
		return nil
	}
	var buf bytes.Buffer
	buf.WriteByte(0x8A)
	length := len(payload)
	if length <= 125 {
		buf.WriteByte(byte(length))
	} else if length <= 65535 {
		buf.WriteByte(126)
		_ = binary.Write(&buf, binary.BigEndian, uint16(length))
	} else {
		buf.WriteByte(127)
		_ = binary.Write(&buf, binary.BigEndian, uint64(length))
	}
	buf.Write(payload)
	_, err := conn.Write(buf.Bytes())
	return err
}

func mustJSON(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}
