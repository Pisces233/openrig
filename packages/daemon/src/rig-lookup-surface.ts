// The openrig plugin's `rig` lookup (#4064): OPENRIG_RIG_BIN when it's executable, else the first `rig` on PATH, and the PATH a
// login shell gets, where an app started outside a terminal finds `rig`. `rig doctor` checks a login shell with these, so
// there's one lookup, in the hook bridge script the plugin runs.
export { findRig, loginShellPath } from "../assets/claude-hook-bridge.cjs";
