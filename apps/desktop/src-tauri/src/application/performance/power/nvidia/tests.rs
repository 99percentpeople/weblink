use super::*;

const EXE: &str = r"C:\Weblink\weblink-desktop.exe";

#[derive(Default)]
struct MemoryProfiles {
    profile: Option<Profile>,
    created: usize,
    writes: usize,
    saves: usize,
    fail_write: bool,
    fail_save: bool,
    discard_write: bool,
}

impl MemoryProfiles {
    fn existing(power: Option<Power>) -> Self {
        Self {
            profile: Some(Profile {
                id: 42,
                base: false,
                application: EXE.into(),
                applications: 1,
                power,
            }),
            ..Default::default()
        }
    }
}

impl Profiles for MemoryProfiles {
    fn find(&mut self, _: &str) -> Result<Option<Profile>> {
        Ok(self.profile.clone())
    }
    fn create(&mut self, executable: &str) -> Result<Profile> {
        self.created += 1;
        let profile = Profile {
            application: executable.into(),
            ..Self::existing(None).profile.unwrap()
        };
        self.profile = Some(profile.clone());
        Ok(profile)
    }
    fn set_power(&mut self, profile: &Profile) -> Result<()> {
        assert_eq!(profile.id, 42);
        self.writes += 1;
        if self.fail_write {
            return Err("Driver refused setting".into());
        }
        if !self.discard_write {
            self.profile.as_mut().unwrap().power = Some(MAX_PERFORMANCE);
        }
        Ok(())
    }
    fn save(&mut self) -> Result<()> {
        self.saves += 1;
        if self.fail_save {
            return Err("Driver refused save".into());
        }
        Ok(())
    }
}

#[test]
fn creates_an_executable_profile_once_and_verifies_the_saved_preference() {
    let mut profiles = MemoryProfiles::default();
    assert!(ensure(&mut profiles, Path::new(EXE)).unwrap());
    assert_eq!(
        profiles.profile.as_ref().unwrap().power,
        Some(MAX_PERFORMANCE)
    );
    assert!(!ensure(&mut profiles, Path::new(EXE)).unwrap());
    assert_eq!(
        (profiles.created, profiles.writes, profiles.saves),
        (1, 1, 1)
    );
}

#[test]
fn updates_only_the_existing_application_power_preference() {
    let mut profiles = MemoryProfiles::existing(Some(Power {
        value: 0,
        location: 0,
    }));
    assert!(ensure(&mut profiles, Path::new(EXE)).unwrap());
    assert_eq!(
        (profiles.created, profiles.writes, profiles.saves),
        (0, 1, 1)
    );
}

#[test]
fn inherited_maximum_performance_still_gets_an_application_override() {
    let mut profiles = MemoryProfiles::existing(Some(Power {
        value: 1,
        location: 2,
    }));
    assert!(ensure(&mut profiles, Path::new(EXE)).unwrap());
    assert_eq!(profiles.profile.unwrap().power, Some(MAX_PERFORMANCE));
}

#[test]
fn refuses_global_shared_basename_and_mismatched_profiles_without_writing() {
    let original = MemoryProfiles::existing(None).profile.unwrap();
    for profile in [
        Profile {
            base: true,
            ..original.clone()
        },
        Profile {
            id: 0,
            ..original.clone()
        },
        Profile {
            applications: 2,
            ..original.clone()
        },
        Profile {
            application: "weblink-desktop.exe".into(),
            ..original.clone()
        },
        Profile {
            application: r"C:\Other\weblink-desktop.exe".into(),
            ..original
        },
    ] {
        let mut profiles = MemoryProfiles {
            profile: Some(profile),
            ..Default::default()
        };
        assert!(ensure(&mut profiles, Path::new(EXE)).is_err());
        assert_eq!(
            (profiles.created, profiles.writes, profiles.saves),
            (0, 0, 0)
        );
    }
}

#[test]
fn driver_normalized_slashes_and_case_still_match_the_same_executable() {
    let mut profiles = MemoryProfiles::existing(Some(MAX_PERFORMANCE));
    profiles.profile.as_mut().unwrap().application = "c:/weblink/weblink-desktop.exe".into();
    assert!(!ensure(&mut profiles, Path::new(EXE)).unwrap());
    assert_eq!(profiles.saves, 0);
}

#[test]
fn rejects_relative_executable_before_creating_a_profile() {
    let mut profiles = MemoryProfiles::default();
    assert!(ensure(&mut profiles, Path::new("weblink-desktop.exe")).is_err());
    assert_eq!(
        (profiles.created, profiles.writes, profiles.saves),
        (0, 0, 0)
    );
}

#[test]
fn driver_failures_are_reported_without_saving_failed_writes() {
    let mut profiles = MemoryProfiles {
        fail_write: true,
        ..MemoryProfiles::existing(None)
    };
    assert!(ensure(&mut profiles, Path::new(EXE))
        .unwrap_err()
        .contains("refused setting"));
    assert_eq!(profiles.saves, 0);
    let mut profiles = MemoryProfiles {
        fail_save: true,
        ..MemoryProfiles::existing(None)
    };
    assert!(ensure(&mut profiles, Path::new(EXE))
        .unwrap_err()
        .contains("refused save"));
    assert_eq!(profiles.saves, 1);
}

#[test]
fn successful_save_without_driver_readback_is_not_reported_as_applied() {
    let mut profiles = MemoryProfiles {
        discard_write: true,
        ..MemoryProfiles::existing(None)
    };
    assert!(ensure(&mut profiles, Path::new(EXE))
        .unwrap_err()
        .contains("did not retain"));
}
