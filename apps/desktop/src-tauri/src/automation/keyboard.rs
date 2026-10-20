//! Named physical keys and Unicode text planning; OS injection stays in desktop-input.
mod plan;
#[cfg(test)]
mod tests;
use std::{collections::BTreeMap, sync::OnceLock};
use weblink_desktop_input::input::ScanCode;

fn codes() -> &'static BTreeMap<String, u16> {
    static CODES: OnceLock<BTreeMap<String, u16>> = OnceLock::new();
    CODES.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../packages/automation/src/keys.json"
        ))
        .expect("automation physical keys")
    })
}
pub fn key(name: &str) -> Result<ScanCode, String> {
    let code = *codes().get(name).ok_or("INVALID_KEY")?;
    ScanCode::new(code & 0xff, code > 0xff).ok_or("INVALID_KEY".into())
}
pub fn name(key: ScanCode) -> &'static str {
    let code = key.code() | if key.extended() { 0x100 } else { 0 };
    codes()
        .iter()
        .find(|(_, c)| **c == code)
        .map(|(name, _)| name.as_str())
        .expect("only named keys enter automation held state")
}
