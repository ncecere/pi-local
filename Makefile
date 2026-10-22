# Pi Local. The Go binaries embed runtime/dist/runtime.mjs and frontend/dist, so build those first (`make build`).
export MACOSX_DEPLOYMENT_TARGET ?= 11.0
export CGO_LDFLAGS ?= -mmacosx-version-min=$(MACOSX_DEPLOYMENT_TARGET)

.PHONY: help deps runtime frontend build app server run-server dev-web test test-go test-runtime test-frontend test-licenses lint check clean package release fakes

help: ## This list
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'

deps: ## Install the runtime's and the frontend's packages
	cd runtime && pnpm install
	cd frontend && pnpm install

runtime: ## Bundle the agent runtime (runtime/dist/runtime.mjs)
	cd runtime && pnpm bundle

frontend: ## Build the UI (frontend/dist)
	cd frontend && pnpm build

build: runtime frontend app server ## Everything: bin/pi-local (desktop) and bin/pi-local-server (headless)

app: ## The desktop app: bin/pi-local
	go build -o bin/pi-local ./cmd/pi-local

server: ## The headless server: bin/pi-local-server
	go build -o bin/pi-local-server ./cmd/pi-local-server

run-server: server ## Headless on http://127.0.0.1:5190: scratch data dir, runtime from source, keys in memory
	bin/pi-local-server -dev -secrets memory -data $${PI_LOCAL_DATA:-/tmp/pi-local-dev}

dev-web: ## The UI with hot reload on :5191, proxying /api to run-server
	cd frontend && pnpm dev

test: test-go test-runtime test-frontend test-licenses ## All tests

test-go: ## Go tests (run the real runtime from source; needs `make deps`)
	go test -count=1 ./internal/... ./cmd/...

test-runtime: ## Runtime typecheck and tests
	cd runtime && pnpm exec tsc --noEmit && pnpm test

test-frontend: ## UI typecheck, lint and tests
	cd frontend && pnpm typecheck && pnpm lint && pnpm test

test-licenses: ## Offline packaging notice tests (NOTICE_TEST_NODE_LICENSE enables installed-tree integration)
	node --test packaging/licenses/build-receipt.test.mjs packaging/licenses/generate.test.mjs packaging/licenses/npm-inventory.test.mjs packaging/licenses/target-evidence.test.mjs
	node --check packaging/licenses/generate.mjs
	bash -n packaging/macos/package.sh

lint: ## go vet and gofmt
	go vet ./internal/... ./cmd/...
	@test -z "$$(gofmt -l cmd internal frontend/embed.go runtime/embed.go)" || (gofmt -l cmd internal; exit 1)

check: lint test ## lint and every test

fakes: ## Fake model, fast-judgments and web search services for QA (ports 5185-5187; see the script's header)
	node scripts/e2e/fake-services.mjs

package: ## Pi Local.app with Node bundled (dist/macos; SIGN_IDENTITY for a Developer ID)
	packaging/macos/package.sh

release: ## package + the update zip (signed with RELEASE_SIGNING_KEY), DMG and SHA256SUMS; VERSION=x.y.z
	RELEASE=1 packaging/macos/package.sh

clean:
	rm -rf bin runtime/dist frontend/dist
