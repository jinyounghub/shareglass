#!/usr/bin/env bash
set -euo pipefail

OWNER="${SHAREGLASS_OWNER:-jinyounghub}"
REPO="${SHAREGLASS_REPO:-shareglass}"
FULL_NAME="$OWNER/$REPO"
DESCRIPTION="See what your files reveal before you share them. Local-first privacy and provenance inspector for Office, PDF, and images."
HOMEPAGE="https://${OWNER}.github.io/${REPO}/"

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI is required: https://cli.github.com/" >&2
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Authenticate first with: gh auth login" >&2
  exit 1
fi
if [[ ! -d .git ]]; then
  git init -b main
fi
if ! git config user.name >/dev/null; then git config user.name "$OWNER"; fi
if ! git config user.email >/dev/null; then
  USER_ID="$(gh api user --jq .id)"
  git config user.email "${USER_ID}+${OWNER}@users.noreply.github.com"
fi

if git diff --quiet && git diff --cached --quiet && [[ -z "$(git ls-files)" ]]; then
  git add -A
  git commit -m "feat: launch ShareGlass v1.0.0"
elif ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  echo "The worktree has uncommitted changes. Review and commit them before publishing." >&2
  git status --short >&2
  exit 1
fi

if ! gh repo view "$FULL_NAME" >/dev/null 2>&1; then
  gh repo create "$FULL_NAME" \
    --public \
    --description "$DESCRIPTION" \
    --homepage "$HOMEPAGE" \
    --source . \
    --remote origin \
    --push
else
  if ! git remote get-url origin >/dev/null 2>&1; then
    git remote add origin "https://github.com/${FULL_NAME}.git"
  fi
  git push -u origin main
fi

gh repo edit "$FULL_NAME" \
  --description "$DESCRIPTION" \
  --homepage "$HOMEPAGE" \
  --enable-issues \
  --enable-discussions=false \
  --add-topic privacy \
  --add-topic metadata \
  --add-topic exif \
  --add-topic office \
  --add-topic pdf \
  --add-topic docx \
  --add-topic c2pa \
  --add-topic local-first \
  --add-topic security \
  --add-topic pwa

# Configure Pages to deploy through the checked-in GitHub Actions workflow.
if gh api "repos/${FULL_NAME}/pages" >/dev/null 2>&1; then
  gh api --method PUT "repos/${FULL_NAME}/pages" -f build_type=workflow >/dev/null
else
  gh api --method POST "repos/${FULL_NAME}/pages" -f build_type=workflow >/dev/null
fi

printf '\nPublished: https://github.com/%s\n' "$FULL_NAME"
printf 'Pages:    %s\n' "$HOMEPAGE"
