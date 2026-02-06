package socketio

import syncengine "hub_go/internal/sync"

func (s *Server) SetEngine(engine *syncengine.Engine) {
	if s == nil {
		return
	}
	s.deps.Engine = engine
}
