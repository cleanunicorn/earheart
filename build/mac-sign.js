// electron-builder's macOS sign hook (electron-builder.yml → mac.sign).
//
// electron-builder only signs with identities `security find-identity -v`
// reports as valid, and a self-signed certificate is valid only once it is
// trusted for code signing — a trust-settings change macOS refuses to make
// non-interactively on CI (authorizationdb: NO -60005). codesign itself signs
// fine with an untrusted certificate named by its SHA-1 hash, so this hook
// passes the hash straight through with identity validation off.
//
// release.yml sets EARHEART_MAC_SIGN_IDENTITY (the certificate's SHA-1) and
// EARHEART_MAC_SIGN_KEYCHAIN after importing the certificate. Without them —
// local `npm run dist:mac`, PR CI, a dry run with no secrets — the build stays
// unsigned, as before.

const { signApp } = require("@electron/osx-sign");

module.exports = async function sign(opts) {
  const identity = process.env.EARHEART_MAC_SIGN_IDENTITY;
  if (!identity) {
    console.log("[mac-sign] EARHEART_MAC_SIGN_IDENTITY not set; leaving the app unsigned");
    return;
  }
  await signApp({
    ...opts,
    identity,
    identityValidation: false,
    keychain: process.env.EARHEART_MAC_SIGN_KEYCHAIN || opts.keychain,
  });
};
