#!/usr/bin/env bash
# Create the labels the issue forms reference. Idempotent — reruns update
# colour and description in place. GitHub silently drops a label an issue
# form requests but that does not exist, so run this once after adding or
# changing the forms.
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

label() {
  gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force >/dev/null
  printf '  %s\n' "$1"
}

printf 'Labels for %s:\n' "$repo"

# bug, enhancement and question are GitHub defaults and already exist;
# only the labels unique to this intake are created here.
label triage "ededed" "Not looked at yet"
label template-submission "0e8a16" "A community gym template for the library"

printf 'Done.\n'
