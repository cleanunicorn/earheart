// Keep an installed macOS update launchable without downgrading its signature.
//
// Apple Silicon refuses to exec an arm64 binary that has no valid code
// signature — the kernel kills it before our JS ever runs, so a bundle that
// arrives unsigned (or with a signature the extract/move invalidated) launches
// to nothing: "the update installed but the app won't open." Verify the
// extracted bundle and, only when the seal is missing or broken, repair it with
// an ad-hoc signature (`-`). A bundle that already verifies — every release,
// now that they are signed with Earheart's certificate — is left untouched:
// re-signing it ad-hoc would change its designated requirement and void the
// user's Accessibility and Automation grants. Throws when the repair fails, so
// the caller can abort before swapping in a bundle that can't start.

const { spawnSync } = require("node:child_process");

function ensureMacSignature(bundle, { run = spawnSync, warn = () => {} } = {}) {
  const verify = run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle]);
  if (verify.status === 0) return "verified";
  warn("updated app has no valid signature; re-signing ad-hoc so it can launch");
  const sign = run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle]);
  if (sign.status !== 0) {
    throw new Error(
      `Could not sign the updated app: ${(sign.stderr || sign.status || "").toString().trim()}`
    );
  }
  return "re-signed";
}

module.exports = { ensureMacSignature };
