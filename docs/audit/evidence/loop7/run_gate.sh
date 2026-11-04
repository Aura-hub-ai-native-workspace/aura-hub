#!/bin/bash
# Run one release gate and keep a durable record of it.
#   usage (from the repository root): docs/audit/evidence/loop4/run_gate.sh <name> <command...>
# Writes <name>.txt (command, working directory, start and end time, host and tool versions, repository
# state, the command's full output) and <name>.exit (the exit code) beside this script. Nothing secret is
# recorded: the gates do not take credentials, and no launch token is ever printed by them.
NAME=$1; shift
DIR=$(cd "$(dirname "$0")" && pwd); OUT=$DIR/$NAME.txt
{
  echo "gate:     $NAME"
  echo "command:  $*"
  echo "cwd:      $(pwd)"
  echo "started:  $(date -Is)"
  echo "host:     $(uname -srm); node $(node -v 2>/dev/null); $(python3 -V 2>&1); load $(cut -d' ' -f1 /proc/loadavg)"
  echo "repo:     branch $(git branch --show-current) HEAD $(git rev-parse --short HEAD); tracked files modified: $(git status --short | grep -v '^??' | grep -vc graphify)"
  echo "----- output -----"
} > "$OUT"
"$@" >> "$OUT" 2>&1
RC=$?
{ echo "----- end -----"; echo "finished: $(date -Is)"; echo "exit:     $RC"; } >> "$OUT"
echo $RC > "$DIR/$NAME.exit"
