#!/usr/bin/env bash
# check.sh: the gate every save in this writing space passes before it becomes a commit.
# Descant runs it on each save. It fails on whitespace errors, credential-shaped lines
# and hard-wrapped prose in an article.md (a paragraph is one source line).
#
# Usage: ./check.sh            # files changed against HEAD (staged or not)
#        ./check.sh <file>...  # named files
# Exit 0 = pass, 1 = fail. Every failure names the file, the line and the reason.
set -uo pipefail
cd "$(dirname "$0")"
fail=0
note() { printf '%s\n' "$1" >&2; fail=1; }

writing_save=""
if [ "${1:-}" = "--writing-save" ]; then
  writing_save="${2:-}"
  shift
fi

if [ "$#" -gt 0 ]; then
  files="$*"
else
  files="$( { git diff --name-only HEAD 2>/dev/null; git diff --cached --name-only 2>/dev/null; } | sort -u )"
fi
[ -n "$files" ] || { echo "check: nothing changed"; exit 0; }

if [ -n "$writing_save" ]; then
  # Typed trailing spaces and blank paragraphs stay in the article; other checks still run.
  git -c core.whitespace=-blank-at-eol,-blank-at-eof diff --check HEAD -- "$writing_save" >/dev/null 2>&1 || note "FAIL article whitespace."
  git diff --check HEAD -- . ":(exclude)$writing_save" >/dev/null 2>&1 || note "FAIL whitespace outside the article."
else
  git diff --check HEAD -- . >/dev/null 2>&1 || note "FAIL whitespace: run 'git diff --check' to see the offending lines."
fi

for f in $files; do
  [ -f "$f" ] || continue
  case "$f" in */article.md|article.md) ;; *) continue ;; esac

  hit=$(grep -niE 'temporary password|temp password|forgejo password' "$f" 2>/dev/null | head -1)
  [ -n "$hit" ] && note "FAIL credential-shaped line in $f -> $hit"

  wrapped=$(awk '
    NR==1 && $0=="---" {fm=1; next}
    fm==1 && $0=="---" {fm=0; next}
    fm==1 {next}
    /^[[:space:]]?[[:space:]]?[[:space:]]?(```|~~~)/ {
      line=$0; sub(/^[[:space:]]*/, "", line)
      match(line, /^`+|^~+/); run=RLENGTH
      rest=substr(line,run+1)
      if (!fence && rest ~ /^([ \t]*[^ \t`]+)?([ \t]+.*)?[ \t]*$/) {
        fence=substr(line,1,1); fence_length=run; prev=0; next
      }
      if (fence && substr(line,1,1)==fence && run>=fence_length && rest ~ /^[[:space:]]*$/) { fence=""; prev=0; next }
    }
    fence {next}
    /^[[:space:]]*$/ {prev=0; next}
    /^[#>]|^[[:space:]]*[-*+][[:space:]]|^[[:space:]]*[0-9]+[.)][[:space:]]|^\||^\[\^|^[[:space:]]*\|/ {prev=0; next}
    { if (prev==1) { print NR; exit } prev=1 }
  ' "$f")
  [ -n "$wrapped" ] && note "FAIL hard-wrapped prose in $f line $wrapped: a paragraph must be one source line."
done

if [ "$fail" -eq 0 ]; then
  echo "check: PASS"
  exit 0
fi
echo "check: FAIL" >&2
exit 1
