GO      = go
GOFLAGS = -mod=vendor

.PHONY: build test test-verbose test-race vet fmt lint check

build:
	$(GO) build $(GOFLAGS) ./...

test:
	$(GO) test $(GOFLAGS) ./internal/... -count=1

test-verbose:
	$(GO) test $(GOFLAGS) ./internal/... -v -count=1

test-race:
	$(GO) test $(GOFLAGS) -race ./internal/... -count=1

vet:
	$(GO) vet $(GOFLAGS) ./...

fmt:
	gofmt -l -w .

lint: vet
	@echo "Lint checks passed (go vet)"

check: vet test
	@echo "All checks passed"
