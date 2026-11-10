#!/usr/bin/env bash
set -euo pipefail

main() {
  local script_dir
  local root_dir
  local target_branch="main"
  local auto_update="${AUTO_UPDATE:-0}"
  local hash_file="node_modules/.veeollax-deps.sha256"

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  root_dir="$(cd "${script_dir}/.." && pwd)"
  cd "${root_dir}"

  if ! command -v node >/dev/null 2>&1; then
    echo "[DEPLOY ERROR] Node.js is not installed or not in PATH." >&2
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "[DEPLOY ERROR] npm is not installed or not in PATH." >&2
    exit 1
  fi

  if [[ "${auto_update}" == "1" ]]; then
    if [[ ! -d .git ]]; then
      echo "[DEPLOY ERROR] AUTO_UPDATE=1 is enabled, but .git directory was not found." >&2
      exit 1
    fi

    if ! command -v git >/dev/null 2>&1; then
      echo "[DEPLOY ERROR] git is not installed or not in PATH." >&2
      exit 1
    fi

    local current_branch
    current_branch="$(git rev-parse --abbrev-ref HEAD)"
    if [[ "${current_branch}" != "${target_branch}" ]]; then
      echo "[DEPLOY ERROR] Active branch is '${current_branch}', expected '${target_branch}'. Aborting startup." >&2
      exit 1
    fi

    echo "[DEPLOY] Pulling latest changes from origin/${target_branch}..."
    if ! git pull --ff-only origin "${target_branch}"; then
      echo "[DEPLOY ERROR] Git pull failed. Aborting startup so stale code is not executed." >&2
      exit 1
    fi
  else
    echo "[DEPLOY] AUTO_UPDATE=${auto_update} - skipping git pull."
  fi

  if [[ ! -f package.json ]]; then
    echo "[DEPLOY ERROR] package.json not found in ${root_dir}." >&2
    exit 1
  fi

  local deps_hash
  deps_hash="$(node -e '
    const crypto = require("crypto");
    const fs = require("fs");
    const hash = crypto.createHash("sha256");
    for (const file of ["package.json", "package-lock.json"]) {
      hash.update(file + ":");
      if (fs.existsSync(file)) {
        hash.update(fs.readFileSync(file));
      }
      hash.update("\n");
    }
    process.stdout.write(hash.digest("hex"));
  ')"

  local needs_install=0
  if [[ ! -d node_modules ]]; then
    needs_install=1
  elif [[ ! -f "${hash_file}" ]] || [[ "$(cat "${hash_file}")" != "${deps_hash}" ]]; then
    needs_install=1
  elif ! node -e '
    const fs = require("fs");
    const path = require("path");
    const deps = Object.keys(require("./package.json").dependencies || {});
    for (const pkg of deps) {
      if (!fs.existsSync(path.join("node_modules", pkg, "package.json"))) {
        process.exit(1);
      }
    }
  ' >/dev/null 2>&1; then
    needs_install=1
  fi

  if [[ "${needs_install}" == "1" ]]; then
    echo "[DEPLOY] Installing production dependencies..."
    if [[ -f package-lock.json ]]; then
      if ! npm ci --omit=dev --no-audit --no-fund; then
        echo "[DEPLOY ERROR] npm ci failed. Aborting startup." >&2
        exit 1
      fi
    else
      if ! npm install --omit=dev --no-package-lock --no-audit --no-fund; then
        echo "[DEPLOY ERROR] npm install failed. Aborting startup." >&2
        exit 1
      fi
    fi

    mkdir -p node_modules
    printf "%s" "${deps_hash}" > "${hash_file}"
  else
    echo "[DEPLOY] Dependencies up to date. Skipping npm install."
  fi

  if [[ ! -f src/index.js ]]; then
    echo "[DEPLOY ERROR] Entrypoint src/index.js not found. Aborting startup." >&2
    exit 1
  fi

  echo "[DEPLOY] Starting Veeollax Care..."
  exec node src/index.js
}

main "$@"
