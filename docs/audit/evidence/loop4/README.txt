Evidence for Alpha loop 4 (2026-10-28). Every *.txt/.exit pair beside run_gate.sh was produced by it: command, working directory,
start/end time, host and tool versions, repository state, full output and exit code. No credentials or launch tokens are recorded.
artifact-final.txt         identity of the final AppImage (sha256 fca9a7af2f65b642ddffb8f61ce256caba710a247d429100ded5abfb612c2772, unsigned)
backend-full / typecheck / desktop-tests / service-tests / lint-changed-files   source gates on the final tree
build-final                the final build (exit 1 only at updater signing)
packaged-harness           packaged-runtime harness against the extracted final artifact (packaged_runtime_harness.py)
packaging-verify           the packaging verifier on the final artifact (62 PASS, exit 0; needs a window manager for 3d/3e)
verifier-run-0-original-package3, verifier-run-A-modified-package3-no-window-manager   earlier verifier runs for the before/after breakdown
acceptance-B-final / acceptance-C-final   acceptance B and C (txt + png) on the final artifact
smoke-final.txt, smoke-*.png, gui-stop-*.png   packaged UI smoke and the F-24 GUI observation
