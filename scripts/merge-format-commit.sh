#!/bin/sh
# Bring the repo-wide oxfmt commit into a branch without a conflict in every
# file it touched. Run on the branch, with a clean tree:
#
#   scripts/merge-format-commit.sh <format-commit>
#
# 1. Merge main up to the commit BEFORE the reformat (real conflicts only).
# 2. Format the branch the same way and commit that.
# 3. Merge the reformat with `-X ours`. Both sides now hold the same
#    formatting, so a hunk that still conflicts is one the branch changed, and
#    the branch's version already carries main's earlier changes.
# 4. Format once more, in case the branch's own code needed it after the merge.
#
# Then `git merge origin/main` as usual for anything after the reformat.
# Merges only: this never rebases.

set -e

FORMAT_COMMIT="$1"
if [ -z "$FORMAT_COMMIT" ]; then
  echo "usage: $0 <format-commit>" >&2
  exit 2
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or set aside your changes first." >&2
  exit 1
fi

# The commit before the reformat already holds .oxfmtrc.json and the pinned
# version, so step 2 formats with exactly what produced the reformat.
format() {
  VERSION=$(node -p 'require("./package.json").devDependencies.oxfmt')
  npx --yes "oxfmt@$VERSION" >/dev/null
}

git merge --no-edit "$FORMAT_COMMIT^"
format
git add -A
git diff --cached --quiet || git commit -m "Format the branch with oxfmt before merging the reformat"
git merge --no-edit -X ours "$FORMAT_COMMIT"
format
git add -A
git diff --cached --quiet || git commit -m "Format code the branch changed after the reformat merge"
