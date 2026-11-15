//! Persistent NVIDIA application preference, independent of capture frame cadence.
//! Never change the base/global profile or a profile shared with another executable.
mod nvapi;
#[cfg(test)]
mod tests;

use super::{Backend, Change, Result};
use std::path::Path;

pub(super) struct Nvidia;

impl Backend for Nvidia {
    fn name(&self) -> Option<&'static str> {
        Some("NVIDIA DRS")
    }
    fn prefer_maximum_performance(&self, executable: &Path) -> Result<Option<Change>> {
        let Some(mut profiles) = nvapi::Driver::open()? else {
            return Ok(None);
        };
        ensure(&mut profiles, executable).map(|changed| {
            Some(if changed {
                Change::Applied
            } else {
                Change::AlreadyApplied
            })
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Power {
    value: u32,
    location: u32,
}

const MAX_PERFORMANCE: Power = Power {
    value: 1,    // PREFERRED_PSTATE_PREFER_MAX
    location: 0, // NVDRS_CURRENT_PROFILE_LOCATION
};

#[derive(Clone, Debug)]
struct Profile {
    id: usize,
    base: bool,
    application: String,
    applications: u32,
    power: Option<Power>,
}

trait Profiles {
    fn find(&mut self, executable: &str) -> Result<Option<Profile>>;
    fn create(&mut self, executable: &str) -> Result<Profile>;
    fn set_power(&mut self, profile: &Profile) -> Result<()>;
    /// Persist the single preference, then reload for independent readback.
    fn save(&mut self) -> Result<()>;
}

fn path_key(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn check_scope(profile: &Profile, executable: &str) -> Result<()> {
    if profile.id == 0
        || profile.base
        || profile.applications != 1
        || path_key(&profile.application) != path_key(executable)
    {
        return Err("NVIDIA profile is not exclusive to this Weblink executable".into());
    }
    Ok(())
}

fn ensure(profiles: &mut impl Profiles, executable: &Path) -> Result<bool> {
    if !executable.is_absolute() {
        return Err("The GPU preference requires an absolute executable path".into());
    }
    let executable = crate::application::executable::normalized_path(executable);
    let profile = match profiles.find(&executable)? {
        Some(profile) => profile,
        None => profiles.create(&executable)?,
    };
    check_scope(&profile, &executable)?;
    if profile.power == Some(MAX_PERFORMANCE) {
        return Ok(false);
    }
    profiles.set_power(&profile)?;
    profiles.save()?;
    let applied = profiles
        .find(&executable)?
        .ok_or("NVIDIA application preference disappeared after saving")?;
    check_scope(&applied, &executable)?;
    if applied.power != Some(MAX_PERFORMANCE) {
        return Err("NVIDIA did not retain the application power preference".into());
    }
    Ok(true)
}
