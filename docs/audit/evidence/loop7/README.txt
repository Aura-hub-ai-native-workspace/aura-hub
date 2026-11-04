Evidence for Alpha loop 7 (2026-10-28). *.txt/*.exit pairs come from run_gate.sh (command, cwd, timestamps, versions, repo state, output, exit code).
baseline-*.txt / final-*.txt   working tree before the loop and at its end (no baseline entry was lost; only additions)
backend-full / typecheck / desktop-tests / service-tests / rust-tests / workflow-yaml / lint-changed-files   gates
build-final                    documented desktop build (exit 1 only at updater signing)      artifact-final.txt   identity, hashes, signing status
parity.txt                     modified backend files vs the staged bundle, plus Node-bundle string probes
packaged-harness               packaged-runtime harness 60/60 (run 1: 57/60 against loop 6's stale home, kept as packaged-harness-run1-stale-home.*)
packaging-verify               verifier 62 pass / 0 fail (run 1 failed: my window manager had died; run 2 failed: /tmp quota during extraction — both kept)
packaged_shutdown_check.py / packaged-shutdown-check.txt   POST /shutdown on the bundled backend with a random token (never printed)
ollama-proposal.txt            F-33 revised proposal: enable the already-installed user unit ollama-aura.service (nothing executed)
