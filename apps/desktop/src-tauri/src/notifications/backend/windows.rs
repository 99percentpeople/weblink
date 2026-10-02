use super::super::{Action, Notification};
use std::path::Path;
use tauri::Manager;
use windows::{
    Data::Xml::Dom::XmlDocument,
    Foundation::{DateTime, IPropertyValue, IReference, PropertyValue, TypedEventHandler},
    UI::Notifications::{
        NotificationSetting, ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
        ToastNotifier,
    },
};
use windows_core::{IInspectable, Interface, HSTRING};

fn notifier(app: &tauri::AppHandle) -> Result<ToastNotifier, String> {
    let icon =
        app.path().app_local_data_dir().ok().and_then(|directory| {
            super::super::image::app_icon(&directory.join("notifications")).ok()
        });
    registered_notifier(&app.config().identifier, icon.as_deref())
}

fn registered_notifier(id: &str, icon: Option<&Path>) -> Result<ToastNotifier, String> {
    // Per-user identity also permits development builds to use their own app name.
    let root = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let (key, _) = root
        .create_subkey(format!("Software\\Classes\\AppUserModelId\\{id}"))
        .map_err(|e| e.to_string())?;
    key.set_value("DisplayName", &"Weblink")
        .map_err(|e| e.to_string())?;
    if let Some(icon) = icon {
        key.set_value("IconUri", &icon.as_os_str())
            .map_err(|e| e.to_string())?;
        key.set_value("IconBackgroundColor", &"00000000")
            .map_err(|e| e.to_string())?;
    }
    ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(id))
        .map_err(|e| e.to_string())
}
// Query only. ERROR_NOT_FOUND means no per-app record yet, not unsupported or granted.
fn permission_state(
    setting: windows_core::Result<NotificationSetting>,
) -> Result<&'static str, String> {
    match setting {
        Ok(NotificationSetting::Enabled) => Ok("granted"),
        Ok(_) => Ok("denied"),
        Err(error) if error.code() == windows::Win32::Foundation::ERROR_NOT_FOUND.to_hresult() => {
            Ok("unknown")
        }
        Err(error) => Err(format!(
            "Could not read Windows notification settings: {error}"
        )),
    }
}
fn query_permission(id: &str) -> Result<&'static str, String> {
    let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(id))
        .map_err(|error| format!("Could not create Windows notification service: {error}"))?;
    permission_state(notifier.Setting())
}
pub fn permission(app: &tauri::AppHandle) -> Result<&'static str, String> {
    query_permission(&app.config().identifier)
}
pub struct Notice {
    toast: ToastNotification,
    notifier: ToastNotifier,
    token: i64,
    tag: HSTRING,
    app_id: HSTRING,
}
impl Drop for Notice {
    fn drop(&mut self) {
        let _ = self.toast.RemoveActivated(self.token);
        let _ = self.notifier.Hide(&self.toast);
        if let Ok(history) = ToastNotificationManager::History() {
            let _ =
                history.RemoveGroupedTagWithId(&self.tag, &HSTRING::from("weblink"), &self.app_id);
        }
    }
}
pub fn show(
    app: &tauri::AppHandle,
    watch_id: &str,
    notification: &Notification,
    icon: Option<&super::super::image::Icon>,
) -> Result<Notice, String> {
    let create = || -> windows_core::Result<(ToastNotification, i64, HSTRING)> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(super::super::xml::toast(
            notification,
            icon.map(|i| i.uri()).as_deref(),
        )))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        let tag = HSTRING::from(&uuid::Uuid::new_v4().simple().to_string()[..16]);
        toast.SetTag(&tag)?;
        toast.SetGroup(&HSTRING::from("weblink"))?;
        let expiry: IReference<DateTime> = PropertyValue::CreateDateTime(DateTime {
            UniversalTime: (notification.expires_at as i64 + 11644473600000) * 10000,
        })?
        .cast()?;
        toast.SetExpirationTime(&expiry)?;
        let app = app.clone();
        let watch_id = watch_id.to_string();
        let id = notification.id.clone();
        let token = toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
            move |_, args| {
                let args = args
                    .as_ref()
                    .ok_or_else(|| {
                        windows_core::Error::from_hresult(windows_core::HRESULT(
                            0x80004003u32 as i32,
                        ))
                    })?
                    .cast::<ToastActivatedEventArgs>()?;
                let action = args.Arguments()?.to_string();
                let text = if action == "reply" {
                    args.UserInput()
                        .and_then(|input| input.Lookup(&HSTRING::from("reply")))
                        .and_then(|v| v.cast::<IPropertyValue>())
                        .and_then(|v| v.GetString())
                        .ok()
                        .map(|s| s.to_string())
                } else {
                    None
                };
                let action = Action {
                    id: id.clone(),
                    action,
                    text,
                };
                let handle = app.clone();
                let watcher = watch_id.clone();
                let _ = app.run_on_main_thread(move || {
                    handle
                        .state::<super::super::Service>()
                        .dispatch(&handle, &watcher, action)
                });
                Ok(())
            },
        ))?;
        Ok((toast, token, tag))
    };
    let notifier = notifier(app)?;
    let (toast, token, tag) = create().map_err(|e| e.to_string())?;
    let notice = Notice {
        toast,
        notifier,
        token,
        tag,
        app_id: HSTRING::from(&app.config().identifier),
    };
    notice
        .notifier
        .Show(&notice.toast)
        .map_err(|e| e.to_string())?;
    Ok(notice)
}

pub fn capabilities(app: &tauri::AppHandle) -> Result<super::super::Capabilities, String> {
    Ok(super::super::Capabilities {
        permission: permission(app)?,
        actions: true,
        reply: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Identity(String);
    impl Drop for Identity {
        fn drop(&mut self) {
            if let Ok(history) = ToastNotificationManager::History() {
                let _ = history.ClearWithId(&HSTRING::from(&self.0));
            }
            let root = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
            let _ =
                root.delete_subkey_all(format!("Software\\Classes\\AppUserModelId\\{}", self.0));
            let _ = root.delete_subkey_all(format!(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\{}",
                self.0
            ));
        }
    }
    #[test]
    fn notification_identity_registers_source_icon_separately_from_avatar() {
        let directory = tempfile::tempdir().unwrap();
        let icon = super::super::super::image::app_icon(directory.path()).unwrap();
        let identity = Identity(format!(
            "ink.webl.icon-test.{}",
            uuid::Uuid::new_v4().simple()
        ));
        let root = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let notifier = registered_notifier(&identity.0, Some(&icon)).unwrap();
        let key = root
            .open_subkey(format!("Software\\Classes\\AppUserModelId\\{}", identity.0))
            .unwrap();
        assert_eq!(
            key.get_value::<String, _>("DisplayName").unwrap(),
            "Weblink"
        );
        assert_eq!(
            key.get_value::<std::ffi::OsString, _>("IconUri").unwrap(),
            icon.as_os_str()
        );
        assert_eq!(
            key.get_value::<String, _>("IconBackgroundColor").unwrap(),
            "00000000"
        );
        drop(notifier);
    }
    #[test]
    fn missing_settings_are_unknown_and_other_errors_remain_errors() {
        assert_eq!(
            permission_state(Ok(NotificationSetting::Enabled)).unwrap(),
            "granted"
        );
        for setting in [
            NotificationSetting::DisabledForApplication,
            NotificationSetting::DisabledForUser,
            NotificationSetting::DisabledByGroupPolicy,
            NotificationSetting::DisabledByManifest,
        ] {
            assert_eq!(permission_state(Ok(setting)).unwrap(), "denied");
        }
        assert_eq!(
            permission_state(Err(windows_core::Error::from_hresult(
                windows::Win32::Foundation::ERROR_NOT_FOUND.to_hresult()
            )))
            .unwrap(),
            "unknown"
        );
        assert!(permission_state(Err(windows_core::Error::from_hresult(
            windows::Win32::Foundation::E_ACCESSDENIED
        )))
        .is_err());
    }

    #[test]
    #[ignore = "uses the real Windows notification service and a temporary app identity"]
    fn permission_query_is_read_only_before_first_dispatch() {
        let id = Identity(format!(
            "ink.webl.notification-test.{}",
            uuid::Uuid::new_v4().simple()
        ));
        let root = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        for _ in 0..2 {
            assert_eq!(query_permission(&id.0).unwrap(), "unknown");
            assert!(root
                .open_subkey(format!("Software\\Classes\\AppUserModelId\\{}", id.0))
                .is_err());
            let fresh =
                ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(&id.0)).unwrap();
            assert_eq!(
                fresh.Setting().unwrap_err().code(),
                windows::Win32::Foundation::ERROR_NOT_FOUND.to_hresult()
            );
        }
        // An explicit test dispatch verifies the natural transition. Queries never send it.
        let notifier = registered_notifier(&id.0, None).unwrap();
        let document = XmlDocument::new().unwrap();
        document
            .LoadXml(&HSTRING::from(crate::notifications::xml::toast(
                &crate::notifications::tests::notice(),
                None,
            )))
            .unwrap();
        let toast = ToastNotification::CreateToastNotification(&document).unwrap();
        toast.SetSuppressPopup(true).unwrap();
        notifier.Show(&toast).unwrap();
        let state = query_permission(&id.0).unwrap();
        assert!(matches!(state, "granted" | "denied"));
        println!(
            "fresh identity: query=unknown without registration; after explicit dispatch={state}"
        );
        notifier.Hide(&toast).unwrap();
    }
    #[test]
    fn native_xml_accepts_inline_reply_and_consent_actions() {
        let n = crate::notifications::tests::notice();
        let mut messages = n.clone();
        messages.actions.clear();
        messages.reply = Some(crate::notifications::Reply {
            title: "发送".into(),
            placeholder: "回复 < &".into(),
        });
        for n in [n, messages] {
            let document = XmlDocument::new().unwrap();
            document
                .LoadXml(&HSTRING::from(crate::notifications::xml::toast(
                    &n,
                    Some("file:///C:/Temp/avatar.png"),
                )))
                .unwrap();
            let toast = ToastNotification::CreateToastNotification(&document).unwrap();
            assert_eq!(
                toast
                    .Content()
                    .unwrap()
                    .GetElementsByTagName(&HSTRING::from("action"))
                    .unwrap()
                    .Length()
                    .unwrap(),
                1
            );
        }
    }
}
