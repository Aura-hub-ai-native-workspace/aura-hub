Evidence for Alpha loop 6 (2026-10-28). *.txt/*.exit pairs come from run_gate.sh (command, cwd, timestamps, versions, repo state, output, exit code).
baseline-*.txt, final-*.txt   working tree before and after       backend-full / typecheck / desktop-tests / service-tests / rust-tests / workflow-yaml / lint-changed-files   gates
build-final                  documented desktop build (exit 1 only at updater signing)      artifact-final.txt   identity, hashes, signing status
packaged-harness / packaging-verify   packaged-runtime harness 60/60 and verifier 62 pass       packaged-shutdown-check.txt   POST /shutdown on the bundled backend
acceptance-B-C.txt           acceptance B and C on the new artifact                          ollama-recommendation.txt   F-33 read-only diagnosis and proposed fix (nothing installed)
