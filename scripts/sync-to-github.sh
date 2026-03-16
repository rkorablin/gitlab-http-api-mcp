#!/usr/bin/env bash
# Sync main → public branch and push to GitHub (without .cursor, ONBOARDING_PROMPT.md).
# Run from repo root after committing on main.
set -e
cd "$(git rev-parse --show-toplevel)"
if [[ $(git status --porcelain) != "" ]]; then
  echo "Commit or stash changes on main first."
  exit 1
fi
git checkout public
git merge main -m "Merge main into public"
# Strip private bits for public repo
git rm -r --cached .cursor 2>/dev/null || true
git rm --cached ONBOARDING_PROMPT.md 2>/dev/null || true
grep -q '\.cursor/' .gitignore 2>/dev/null || echo -e "\n# Public repo: do not expose\n.cursor/" >> .gitignore
grep -q 'ONBOARDING_PROMPT' .gitignore 2>/dev/null || echo "ONBOARDING_PROMPT.md" >> .gitignore
if [[ $(git status --porcelain) != "" ]]; then
  git add -A
  git commit -m "Exclude .cursor and ONBOARDING_PROMPT for public repo"
fi
git push github public:main
git checkout main
echo "Pushed public branch to github (main)."
