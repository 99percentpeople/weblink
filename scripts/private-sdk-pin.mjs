const SDK_URL =
  "https://github.com/99percentpeople/rust-sdks.git";

/** Require both patched crates to use the same immutable SDK source. */
export function privateSdkRevision(manifest) {
  const patches = manifest?.patch?.["crates-io"];
  const bindings = ["libwebrtc", "webrtc-sys"].map(
    (name) => patches?.[name],
  );
  if (
    bindings.some(
      (entry) =>
        entry?.git !== SDK_URL ||
        !/^[a-f0-9]{40}$/.test(entry?.rev ?? "") ||
        entry.path ||
        entry.branch ||
        entry.tag,
    ) ||
    bindings[0].rev !== bindings[1].rev
  ) {
    throw new Error(
      "Native SDK patches must share one full Git revision from the Weblink SDK repository",
    );
  }
  return bindings[0].rev;
}

if (import.meta.main) {
  const manifest = Bun.TOML.parse(
    await Bun.file("Cargo.toml").text(),
  );
  console.log(privateSdkRevision(manifest));
}
