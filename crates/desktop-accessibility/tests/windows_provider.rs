#![cfg(windows)]
//! Real UIA against an owned disposable WinForms process, never a user's existing app.
use serde_json::Value;
use std::{
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};
use weblink_desktop_accessibility::{
    Access, Action, Client, Error, Observation, ReadOptions, Request,
};

struct Fixture {
    process: Child,
    files: tempfile::TempDir,
    title: String,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}
impl Fixture {
    fn start() -> Self {
        let files = tempfile::tempdir().unwrap();
        let script = files.path().join("fixture.ps1");
        std::fs::write(&script, r#"
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:WEBLINK_UIA_FIXTURE_TITLE
$form.Width = 400
$form.Height = 200
$inputBox = New-Object System.Windows.Forms.TextBox
$inputBox.AccessibleName = 'Fixture input'
$inputBox.Text = 'initial'
$inputBox.SetBounds(10,10,220,25)
$password = New-Object System.Windows.Forms.TextBox
$password.AccessibleName = 'Secret'
$password.UseSystemPasswordChar = $true
$password.Text = 'fixture-secret-do-not-export'
$password.SetBounds(10,45,220,25)
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Fixture save'
$button.SetBounds(10,80,150,30)
$button.Add_Click({ [IO.File]::WriteAllText(($env:WEBLINK_UIA_FIXTURE_DIR + '/saved'), $inputBox.Text) })
$form.Controls.AddRange(@($inputBox,$password,$button))
$form.Add_Shown({ [IO.File]::WriteAllText(($env:WEBLINK_UIA_FIXTURE_DIR + '/ready'), 'ready') })
[System.Windows.Forms.Application]::Run($form)
"#).unwrap();
        let title = format!("Weblink UIA fixture {}", uuid::Uuid::new_v4());
        let process = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .env("WEBLINK_UIA_FIXTURE_DIR", files.path())
            .env("WEBLINK_UIA_FIXTURE_TITLE", &title)
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let fixture = Self {
            process,
            files,
            title,
        };
        let start = Instant::now();
        while !fixture.files.path().join("ready").exists() {
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "fixture UI did not start"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        fixture
    }
}
fn access() -> Access {
    Access {
        owner: "fixture-test".into(),
        check: Arc::new(|| Ok(())),
        lease: Arc::new(|| Ok(())),
    }
}
fn snapshot(client: &Client, fixture: &Fixture) -> Value {
    let windows = client
        .call(Request::Windows { limit: 128 }, access())
        .unwrap();
    assert!(windows["windows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|w| w["processId"] != std::process::id()));
    let root = windows["windows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["name"] == fixture.title)
        .unwrap_or_else(|| {
            panic!(
                "owned fixture {} absent from {} accessible roots (pids: {:?})",
                fixture.process.id(),
                windows["windows"].as_array().unwrap().len(),
                windows["windows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|w| &w["processId"])
                    .collect::<Vec<_>>()
            )
        })["elementId"]
        .as_str()
        .unwrap()
        .to_string();
    client
        .call(
            Request::Snapshot {
                element_id: root,
                max_depth: 4,
                max_nodes: 64,
                options: ReadOptions {
                    include_values: true,
                    ..Default::default()
                },
            },
            access(),
        )
        .unwrap()
}
fn named(tree: &Value, name: &str) -> String {
    tree["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["name"] == name)
        .expect("fixture control is accessible")["elementId"]
        .as_str()
        .unwrap()
        .into()
}
#[test]
#[ignore = "requires an interactive Windows desktop; run explicitly with --ignored"]
fn real_uia_inspects_redacts_sets_value_and_invokes_only_owned_fixture() {
    let fixture = Fixture::start();
    let client = Client::default();
    assert_eq!(
        client.call(Request::Capabilities, access()).unwrap()["backend"],
        "windows-uia"
    );
    let tree = snapshot(&client, &fixture);
    assert!(!tree.to_string().contains("fixture-secret-do-not-export"));
    let secret = tree["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["protected"] == true)
        .unwrap();
    assert_eq!(secret["name"], "");
    assert_eq!(secret["actions"], serde_json::json!([]));
    let input = named(&tree, "Fixture input");
    let button = named(&tree, "Fixture save");
    let applied = client
        .call(
            Request::Action {
                element_id: input,
                action: Action::SetValue,
                value: Some("UIA 测试 ✓".into()),
                observe_after: Some(Observation {
                    include_values: true,
                    ..Default::default()
                }),
            },
            access(),
        )
        .unwrap();
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["refreshRequired"], false);
    assert_eq!(applied["observation"]["nodes"][0]["value"], "UIA 测试 ✓");
    assert_eq!(
        client.call(
            Request::Action {
                element_id: button,
                action: Action::Invoke,
                value: None,
                observe_after: None,
            },
            access()
        ),
        Err(Error::StaleElement)
    );
    let button = named(&snapshot(&client, &fixture), "Fixture save");
    client
        .call(
            Request::Action {
                element_id: button,
                action: Action::Invoke,
                value: None,
                observe_after: None,
            },
            access(),
        )
        .unwrap();
    let start = Instant::now();
    let saved = fixture.files.path().join("saved");
    loop {
        if std::fs::read_to_string(&saved).is_ok_and(|v| v == "UIA 测试 ✓") {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "invoke did not save the supplied value"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
#[ignore = "requires an interactive Windows desktop; only activates disposable fixture windows"]
fn real_window_binding_checks_focus_identity_and_rejects_child_references() {
    use weblink_desktop_input::input::Error as InputError;
    let mut first = Fixture::start();
    let client = Client::default();
    let first_tree = snapshot(&client, &first);
    let root = first_tree["nodes"][0]["elementId"]
        .as_str()
        .unwrap()
        .to_string();
    let child = named(&first_tree, "Fixture input");
    assert!(matches!(
        client.bind_window(child, access()),
        Err(Error::InvalidArguments)
    ));
    let first_window = client.bind_window(root, access()).unwrap();
    first_window.activate().unwrap();
    first_window.check(None).unwrap();
    // Point outside any screen/window must never be accepted for bound pointer input.
    assert_eq!(
        first_window.check(Some((i32::MIN, i32::MIN))),
        Err(InputError::WindowPointOutside)
    );
    let second = Fixture::start();
    let second_tree = snapshot(&client, &second);
    let second_root = second_tree["nodes"][0]["elementId"]
        .as_str()
        .unwrap()
        .to_string();
    let second_window = client.bind_window(second_root, access()).unwrap();
    second_window.activate().unwrap();
    assert_eq!(first_window.check(None), Err(InputError::WindowFocusLost));
    first.process.kill().unwrap();
    first.process.wait().unwrap();
    assert_eq!(first_window.check(None), Err(InputError::WindowUnavailable));
    drop(first_window);
    second_window.check(None).unwrap();
}
