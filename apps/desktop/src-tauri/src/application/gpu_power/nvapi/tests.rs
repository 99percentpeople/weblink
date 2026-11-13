use super::*;

#[test]
fn unicode_paths_have_space_for_a_terminator_and_are_never_truncated() {
    let path = "C:/桌面/Weblink 🖥/weblink-desktop.exe";
    assert_eq!(string(&unicode(path).unwrap()).unwrap(), path);
    assert!(unicode(&"a".repeat(2047)).is_ok());
    assert!(unicode(&"a".repeat(2048)).is_err());
    assert!(unicode("app\0other.exe").is_err());
    assert!(string(&[1; 2048]).is_err());
}

struct TemporaryProfile {
    driver: Driver,
    executable: String,
}

impl TemporaryProfile {
    fn remove(&mut self) -> Result<()> {
        self.driver.api.check(
            unsafe { (self.driver.api.load)(self.driver.session) },
            "Reload test profile",
        )?;
        if let Some(profile) = self.driver.find(&self.executable)? {
            super::super::check_scope(&profile, &self.executable)?;
            let pointer = unsafe { (self.driver.api.query)(0x1709_3206) }; // NvAPI_DRS_DeleteProfile
            assert!(!pointer.is_null());
            let delete: unsafe extern "C" fn(Handle, Handle) -> Status =
                unsafe { std::mem::transmute(pointer) };
            self.driver.api.check(
                unsafe { delete(self.driver.session, profile.id as Handle) },
                "Remove test profile",
            )?;
            self.driver.save()?;
        }
        Ok(())
    }
}

impl Drop for TemporaryProfile {
    fn drop(&mut self) {
        if let Err(error) = self.remove() {
            eprintln!(
                "Could not remove test NVIDIA profile for {}: {error}",
                self.executable
            );
        }
    }
}

#[test]
#[ignore = "Requires NVIDIA DRS; creates and removes a profile for a temporary dummy executable"]
fn native_profile_is_scoped_persistent_idempotent_and_preserves_global_power() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("weblink-desktop.exe");
    std::fs::write(&executable, []).unwrap();
    let path = crate::application::executable::normalized_path(&executable);
    let mut driver = Driver::open().unwrap().expect("NVIDIA driver required");
    assert!(driver.find(&path).unwrap().is_none());
    let original_global = driver.power(driver.base).unwrap();
    let mut guard = TemporaryProfile {
        driver,
        executable: path.clone(),
    };
    assert!(super::super::ensure(&mut guard.driver, &executable).unwrap());
    assert!(!super::super::ensure(&mut guard.driver, &executable).unwrap());
    // A new DRS session proves this was saved rather than just cached locally.
    let mut reopened = Driver::open().unwrap().unwrap();
    let profile = reopened.find(&path).unwrap().unwrap();
    assert_eq!(profile.power, Some(MAX_PERFORMANCE));
    super::super::check_scope(&profile, &path).unwrap();
    assert_eq!(reopened.power(reopened.base).unwrap(), original_global);
    drop(reopened);
    guard.remove().unwrap();
    assert!(guard.driver.find(&path).unwrap().is_none());
    assert_eq!(
        guard.driver.power(guard.driver.base).unwrap(),
        original_global
    );
}
