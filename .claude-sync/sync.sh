#!/usr/bin/env bash
# Syncs CLAUDE.md / .claude/skills / .claude/agents symlinks from the sibling
# js-recon-agentic-files checkout to match the currently checked-out branch of
# this repo.
set -euo pipefail

JS_RECON_ROOT="$(git rev-parse --show-toplevel)"
AGENTIC_REPO_PATH="${JSR_AGENTIC_FILES_PATH:-$JS_RECON_ROOT/../js-recon-agentic-files}"
FALLBACK_BRANCH="${JSR_AGENTIC_FALLBACK_BRANCH:-dev}"

CURRENT_BRANCH="$(git -C "$JS_RECON_ROOT" symbolic-ref --short HEAD 2>/dev/null || echo "")"

if [ -z "$CURRENT_BRANCH" ]; then
    echo "[claude-sync] detached HEAD, skipping sync"
    exit 0
fi

if [ ! -d "$AGENTIC_REPO_PATH/.git" ]; then
    echo "[claude-sync] agentic-files repo not found at $AGENTIC_REPO_PATH — see js-recon-agentic-files/README.md for setup"
    exit 0
fi

(
    cd "$AGENTIC_REPO_PATH"
    git fetch origin --quiet

    if git show-ref --verify --quiet "refs/remotes/origin/$CURRENT_BRANCH"; then
        git checkout -B "$CURRENT_BRANCH" "origin/$CURRENT_BRANCH" --quiet
    else
        echo "[claude-sync] WARNING: no 'origin/$CURRENT_BRANCH' branch in agentic-files repo — falling back to 'origin/$FALLBACK_BRANCH'"
        git checkout -B "$CURRENT_BRANCH" "origin/$FALLBACK_BRANCH" --quiet
    fi
)

# 1. Remove stale symlinks that point into the agentic checkout but whose target
#    no longer exists on this branch (e.g. switched to a branch with fewer files).
while IFS= read -r link; do
    target="$(readlink "$link")"
    case "$target" in
        "$AGENTIC_REPO_PATH"/*)
            if [ ! -e "$target" ]; then
                rm "$link"
                echo "[claude-sync] removed stale symlink: ${link#$JS_RECON_ROOT/}"
            fi
            ;;
    esac
done < <(find "$JS_RECON_ROOT" -type l \( -name "CLAUDE.md" -o -path "*/.claude/skills/*" -o -path "*/.claude/agents/*" \) -not -path "*/.git/*" -not -path "*/node_modules/*" -not -path "*/build/*")

# 2. Create/update symlinks for every CLAUDE.md (and .claude/skills / .claude/agents
#    entry) present on this branch in the agentic checkout.
while IFS= read -r src; do
    rel="${src#$AGENTIC_REPO_PATH/}"
    dest="$JS_RECON_ROOT/$rel"

    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
        echo "[claude-sync] WARNING: $rel exists as a real (non-symlink) file — not overwriting. Stage it to trigger capture, or remove it manually."
        continue
    fi

    mkdir -p "$(dirname "$dest")"
    ln -sf "$src" "$dest"
done < <(find "$AGENTIC_REPO_PATH" \( -name "CLAUDE.md" -o -path "*/.claude/skills/*" -o -path "*/.claude/agents/*" \) -type f -not -path "*/.git/*")

echo "[claude-sync] synced CLAUDE.md / skills / agents files for branch '$CURRENT_BRANCH'"
