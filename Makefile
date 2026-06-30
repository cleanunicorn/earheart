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

.PHONY: screenshots
screenshots: ## Regenerate README screenshots into docs/screenshots/
	xvfb-run -a npx electron scripts/screenshots.js --no-sandbox

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
	# The app ships native, per-platform addons (sherpa-onnx-node, node-llama-cpp)
	# whose real binaries are selected by os/cpu-gated optionalDependencies. A
	# plain `npm ci` inside this Linux container installs the *Linux* binaries, so
	# the resulting .exe would crash with "sherpa-onnx-node not available". After
	# the install we force-add the Windows packages via npm's --os/--cpu override
	# so the win build bundles win binaries.
	#
	# `-v /project/node_modules` mounts a throwaway container volume over the
	# bind-mounted source tree's node_modules: the container (root) never writes
	# into the host's node_modules, so a host `npm start` keeps working afterward.
	# Only dist/ is written back to the host.
	#
	# NOTE: this produces a build but can't be runtime-verified from Linux — the
	# supported, fully-tested path is CI (release.yml builds Windows on
	# windows-latest) or `npm run dist:win` on a real Windows machine.
	docker run --rm --security-opt seccomp=unconfined \
		-v "$(CURDIR)":/project -v /project/node_modules -w /project \
		electronuserland/builder:wine \
		/bin/bash -c "npm ci && \
			npm install --no-save --force --os=win32 --cpu=x64 \
				sherpa-onnx-win-x64 @node-llama-cpp/win-x64 && \
			npm run dist:win"

# ----- releasing -------------------------------------------------------------

# Releases also happen automatically when a PR merges to master, sized by the
# PR title (see .github/workflows/auto-release.yml). This target is the manual
# path: bump version, commit, tag, push — CI builds and publishes installers.
.PHONY: release
release: ## Cut a release: bump, tag, push (BUMP=patch|minor|major, default patch)
	npm version $(or $(BUMP),patch)
	git push origin master --follow-tags

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
