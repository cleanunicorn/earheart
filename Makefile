# Earheart — common development tasks.
# Run `make` or `make help` to list targets.

.DEFAULT_GOAL := help

# ----- app (Electron) -------------------------------------------------------

.PHONY: install
install: ## Install app dependencies (npm)
	npm install

.PHONY: run
run: ## Run the app in development
	npm start

.PHONY: test
test: ## Run unit tests
	npm test

.PHONY: smoke
smoke: ## Boot the app headlessly and exit (CI-style sanity check)
	xvfb-run -a npx electron . --smoke-test --no-sandbox

.PHONY: icons
icons: ## Regenerate app/tray icons into assets/
	node scripts/gen-icons.js

# ----- packaging ------------------------------------------------------------

.PHONY: dist
dist: ## Build installers for the current platform
	npm run dist

.PHONY: dist-linux
dist-linux: ## Build Linux packages (AppImage, deb)
	npm run dist:linux

.PHONY: dist-mac
dist-mac: ## Build macOS packages (dmg, zip) — run on macOS
	npm run dist:mac

.PHONY: dist-win
dist-win: ## Build Windows packages (NSIS, portable) — run on Windows
	npm run dist:win

.PHONY: dist-win-docker
dist-win-docker: ## Cross-build Windows packages from Linux via Docker+Wine
	docker run --rm --security-opt seccomp=unconfined \
		-v "$(CURDIR)":/project -w /project \
		electronuserland/builder:wine \
		/bin/bash -c "npm install && npm run dist:win"

# ----- speech-to-text server (Python) ---------------------------------------

.PHONY: install-stt
install-stt: ## Create the stt-server virtualenv and install it (uv)
	cd stt-server && uv venv && uv pip install -e .

.PHONY: run-stt
run-stt: ## Run the local Parakeet STT server (downloads model on first run)
	cd stt-server && uv run earheart-stt

.PHONY: run-stt-int8
run-stt-int8: ## Run the STT server with the smaller/faster int8 model
	cd stt-server && uv run earheart-stt --quantization int8

# ----- housekeeping ---------------------------------------------------------

.PHONY: clean
clean: ## Remove build output
	rm -rf dist

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) | \
		awk -F':.*## ' '{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
