Evidence for Alpha loop 5, the cross-platform audit (2026-10-28). Each *.txt / *.exit pair was produced by run_gate.sh (command, cwd,
timestamps, host and tool versions, repository state, full output, exit code). No tokens or keys are recorded.
baseline-*.txt                  the working tree as found (git status, diff stat, notes) before any change
backend-full / typecheck / desktop-tests / service-tests / rust-tests / glibc-floor / lint-changed-files   gates on the final tree
build-final                     the documented desktop build (exit 1 only at updater signing)
artifact-final.txt              identity of the final AppImage and .deb, signing status, provenance
packaged-harness / packaging-verify   packaged-runtime harness (60/60) and packaging verifier (62 pass) on the final artifact
regression-targeted.txt         per-finding regression runs (F-12, Windows paths, F-17, F-20/27, F-23, F-24/08, F-26, F-28, F-29)
packaged-acceptance-and-gui.txt acceptance B and C, graceful quit, GUI cancellation, network snapshot, method corrections
acceptance-*.png, gui-stop-*.png   screenshots (see the record for what each shows and does not show)
ollama-diagnosis.txt, ollama-option-A/B-*.service   F-33 read-only diagnosis and PROPOSED unit files (not installed)
final-git-status.txt, final-diff-stat.txt   the working tree at the end
run_gate.sh                     the recording wrapper (copy of loop 4's)
