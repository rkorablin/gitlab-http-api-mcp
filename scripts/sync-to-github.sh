#!/usr/bin/env bash
# Sync main → public branch and push to GitHub (without .cursor).
# Run from repo root after committing on main.
set -e
cd "$(git rev-parse --show-toplevel)"
if [[ $(git status --porcelain) != "" ]]; then
  echo "Commit or stash changes on main first."
  exit 1
fi
git checkout public
git merge main -m "Merge main into public"
# Remove .cursor if merge brought it back (public must not contain it)
git rm -r --cached .cursor 2>/dev/null || true
if [[ $(git status --porcelain) != "" ]]; then
  git add -A
  git commit -m "Exclude .cursor for public repo"
fi
git push github public:main
git checkout main
echo "Pushed public branch to github (main)."
