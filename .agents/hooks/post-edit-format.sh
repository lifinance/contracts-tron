#!/usr/bin/env bash
# PostToolUse hook: auto-format edited file with oxfmt / forge fmt (silent)
# Triggered on: Write, Edit, MultiEdit
# Reads tool JSON from stdin; exits 0 always (never blocks Claude)

INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[[ -z "$FILE" || ! -f "$FILE" ]] && exit 0

ROOT=$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null || pwd)

case "$FILE" in
  *.ts|*.js)
    cd "$ROOT" && bunx oxfmt --no-error-on-unmatched-pattern "$FILE" >/dev/null 2>&1
    ;;
  "$ROOT"/src/*.sol|src/*.sol)
    # foundry.toml [fmt] ignores src/ (audited sources); explicit paths bypass that list
    ;;
  *.sol)
    cd "$ROOT" && forge fmt "$FILE" >/dev/null 2>&1
    ;;
esac

exit 0
