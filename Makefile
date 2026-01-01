.PHONY: help install dev build start stop restart status logs test clean

.DEFAULT_GOAL := help

-include .env
export

UTUN4_IP := $(shell ifconfig -L utun4 2>/dev/null | grep -o 'inet [0-9.]*' | awk '{print $$2}')
WEBAPP_PORT ?= 8899
WEBAPP_URL := http://$(UTUN4_IP):$(WEBAPP_PORT)
HAPI_SERVER_URL := http://$(UTUN4_IP):$(WEBAPP_PORT)

PID_FILE = .server.pid

help:
	@echo "HAPI 项目管理"
	@echo ""
	@echo "开发:"
	@echo "  make dev              启动开发模式（server + web）"
	@echo "  make dev-server       启动 server 开发模式"
	@echo "  make dev-web          启动 web 开发模式"
	@echo ""
	@echo "构建:"
	@echo "  make build            构建所有项目"
	@echo "  make build-exe        构建可执行文件"
	@echo ""
	@echo "运行:"
	@echo "  make start            启动 server（后台）"
	@echo "  make start-debug      启动 server（后台，DEBUG 模式）"
	@echo "  make start-fg         启动 server（前台，实时日志）"
	@echo "  make stop             停止 server"
	@echo "  make restart          重启 server"
	@echo "  make status           查看状态"
	@echo "  make logs             查看日志"
	@echo ""
	@echo "其他:"
	@echo "  make install          安装依赖"
	@echo "  make test             运行测试"
	@echo "  make typecheck        类型检查"
	@echo "  make clean            清理构建产物"
	@echo ""
	@echo "环境变量:"
	@echo "  DEBUG=true make start 启用调试日志"
	@echo ""

install:
	@bun install

dev:
	@bun run dev

dev-server:
	@cd server && bun run dev

dev-web:
	@cd web && bun run dev

build:
	@bun run build

build-exe:
	@bun run build:single-exe

start:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Server 已在运行（PID: $$(cat $(PID_FILE))）"; \
		exit 1; \
	fi
	@echo "启动 Server..."
	@echo "WEBAPP_URL: $(WEBAPP_URL)"
	@echo "HAPI_HOME: $(HAPI_HOME)"
	@mkdir -p $(HAPI_HOME)
	@cd server && nohup bun run src/index.ts > ../server.log 2>&1 & echo $$! > ../$(PID_FILE)
	@sleep 3
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Server 启动成功（PID: $$(cat $(PID_FILE))）"; \
	else \
		echo "Server 启动失败，请查看 server.log"; \
		rm -f $(PID_FILE); \
		exit 1; \
	fi

start-debug:
	@DEBUG=true $(MAKE) start

start-cli:
	@cd cli && bun run src/index.ts

start-fg:
	@echo "启动 Server（前台模式）..."
	@echo "WEBAPP_URL: $(WEBAPP_URL)"
	@echo "HAPI_HOME: $(HAPI_HOME)"
	@echo "DEBUG: $(DEBUG)"
	@mkdir -p $(HAPI_HOME)
	@cd server && bun run src/index.ts 2>&1 | tee ../server.log

stop:
	@if [ ! -f $(PID_FILE) ]; then \
		echo "Server 未运行"; \
		exit 0; \
	fi
	@if kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		kill $$(cat $(PID_FILE)) && echo "Server 已停止"; \
	else \
		echo "Server 进程不存在"; \
	fi
	@rm -f $(PID_FILE)

restart: stop
	@sleep 1
	@$(MAKE) start

status:
	@if [ -f $(PID_FILE) ] && kill -0 $$(cat $(PID_FILE)) 2>/dev/null; then \
		echo "Server 运行中（PID: $$(cat $(PID_FILE))）"; \
		echo "WEBAPP_URL: $(WEBAPP_URL)"; \
	else \
		echo "Server 未运行"; \
		[ -f $(PID_FILE) ] && rm -f $(PID_FILE); \
	fi

logs:
	@tail -f server.log

test:
	@bun run test

typecheck:
	@bun run typecheck

clean:
	@rm -rf cli/dist cli/bin/*.exe cli/npm/*/hapi* cli/.bun-build
	@rm -rf server/dist web/dist
	@rm -f server.log $(PID_FILE)
	@echo "清理完成"
