# Local Fork Workflow (copy/paste friendly)

Use this when you want to run **your forked HAPI build** locally and keep it updated with `tiann/hapi`.

Current remote layout in this repo:

- `origin` = upstream (`https://github.com/tiann/hapi.git`)
- `fork` = your fork (`https://github.com/gaius-codius/hapi.git`)

---

## 1) One-time switch from global npm package to your local fork build

```bash
# from anywhere
which hapi
npm list -g @twsxtd/hapi
npm uninstall -g @twsxtd/hapi
hash -r

# from repo root
cd /home/gretus/code/hapi
git checkout main
bun install
bun run build:single-exe

# install your built binary to user path
install -Dm755 cli/dist-exe/bun-linux-x64/hapi ~/.local/bin/hapi
hash -r

# verify
which hapi
hapi --version
```

If `~/.local/bin` not in PATH, add it:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

## 2) Manual ongoing update flow

```bash
cd /home/gretus/code/hapi
git checkout main
git fetch origin
git fetch fork
git merge origin/main
bun install
bun run build:single-exe
install -Dm755 cli/dist-exe/bun-linux-x64/hapi ~/.local/bin/hapi
git push fork main
```

Optional extra validation before build:

```bash
bun run typecheck
bun run test:web
```

---

## 3) Scripted ongoing update flow (recommended)

Script added at:

```text
scripts/update-local-hapi.sh
```

Make executable once:

```bash
cd /home/gretus/code/hapi
chmod +x scripts/update-local-hapi.sh
```

Run it:

```bash
cd /home/gretus/code/hapi
./scripts/update-local-hapi.sh
```

Run with validation:

```bash
cd /home/gretus/code/hapi
RUN_TESTS=1 ./scripts/update-local-hapi.sh
```

Optional env overrides:

```bash
UPSTREAM_REMOTE=origin FORK_REMOTE=fork MAIN_BRANCH=main INSTALL_DIR="$HOME/.local/bin" ./scripts/update-local-hapi.sh
```

---

## 4) Quick checks

```bash
git remote -v
git status -sb
which hapi
hapi --version
```

Going forward, run ./scripts/update-local-hapi.sh from the repo root to pull upstream changes, rebuild, and reinstall.