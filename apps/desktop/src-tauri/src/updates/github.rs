use reqwest::{Client, StatusCode};
use semver::Version;
use serde::Deserialize;
use std::time::Duration;

const ENDPOINT: &str = "https://api.github.com/repos/99percentpeople/weblink/releases/latest";
const RELEASES: &str = "https://github.com/99percentpeople/weblink/releases";
const INSTALLER: &str = "Weblink-windows-x64-setup.exe";
const PORTABLE: &str = "Weblink-windows-x64-portable.zip";

#[derive(Debug)]
pub(super) struct ReleaseUpdate {
    pub version: String,
    pub notes: Option<String>,
    pub download_url: String,
    pub manifest_url: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    state: String,
    browser_download_url: String,
}

impl Release {
    fn asset_url(&self, name: &str) -> Option<String> {
        let expected = format!("{RELEASES}/download/{}/{name}", self.tag_name);
        self.assets
            .iter()
            .find(|asset| {
                asset.name == name
                    && asset.state == "uploaded"
                    && asset.browser_download_url == expected
            })
            .map(|asset| asset.browser_download_url.clone())
    }

    fn into_update(
        self,
        current: &Version,
        installed: bool,
    ) -> Result<Option<ReleaseUpdate>, String> {
        if self.draft || self.prerelease {
            return Ok(None);
        }
        let version = Version::parse(self.tag_name.strip_prefix('v').unwrap_or(&self.tag_name))
            .map_err(|error| format!("Invalid GitHub release version: {error}"))?;
        if !version.pre.is_empty() || !version.build.is_empty() || version <= *current {
            return Ok(None);
        }
        let asset = if installed { INSTALLER } else { PORTABLE };
        let download_url = self
            .asset_url(asset)
            .ok_or_else(|| format!("GitHub release {} is missing {asset}", self.tag_name))?;
        let manifest_url = self.asset_url("latest.json");
        Ok(Some(ReleaseUpdate {
            version: version.to_string(),
            notes: self.body,
            download_url,
            manifest_url,
        }))
    }
}

fn client(current: &Version) -> Result<Client, String> {
    // Share the updater plugin's TLS provider without enabling a second crypto backend.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    Client::builder()
        .user_agent(format!("Weblink/{current}"))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())
}

pub(super) async fn check(
    current: &Version,
    installed: bool,
) -> Result<Option<ReleaseUpdate>, String> {
    check_endpoint(&client(current)?, ENDPOINT, current, installed).await
}

async fn check_endpoint(
    client: &Client,
    endpoint: &str,
    current: &Version,
    installed: bool,
) -> Result<Option<ReleaseUpdate>, String> {
    let response = client
        .get(endpoint)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|error| format!("GitHub release check failed: {error}"))?;
    // A public repository with no published stable release returns 404.
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let release = response
        .error_for_status()
        .map_err(|error| format!("GitHub release check failed: {error}"))?
        .json::<Release>()
        .await
        .map_err(|error| format!("Invalid GitHub release response: {error}"))?;
    // Version discovery reads API metadata only; attachments are fetched after install consent.
    release.into_update(current, installed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread::{self, JoinHandle},
        time::Instant,
    };

    fn release(tag: &str) -> Release {
        Release {
            tag_name: tag.into(),
            body: Some("Release notes from GitHub".into()),
            draft: false,
            prerelease: false,
            assets: [INSTALLER, PORTABLE, "latest.json"]
                .into_iter()
                .map(|name| Asset {
                    name: name.into(),
                    state: "uploaded".into(),
                    browser_download_url: format!("{RELEASES}/download/{tag}/{name}"),
                })
                .collect(),
        }
    }

    #[test]
    fn compares_semantic_versions_and_only_offers_new_stable_releases() {
        let current = Version::parse("1.9.0").unwrap();
        for tag in ["v1.9.0", "v1.8.9", "v1.10.0-beta.1", "v1.10.0+build.1"] {
            assert!(release(tag).into_update(&current, true).unwrap().is_none());
        }
        for tag in ["v1.10.0", "1.10.0"] {
            let update = release(tag).into_update(&current, true).unwrap().unwrap();
            assert_eq!(update.version, "1.10.0");
        }
        let mut draft = release("v2.0.0");
        draft.draft = true;
        assert!(draft.into_update(&current, true).unwrap().is_none());
        let mut prerelease = release("v2.0.0");
        prerelease.prerelease = true;
        assert!(prerelease.into_update(&current, true).unwrap().is_none());
        for tag in ["latest", "v1.02.0", "v2.0"] {
            assert!(release(tag).into_update(&current, true).is_err());
        }
    }

    #[test]
    fn selects_the_matching_package_and_pins_the_manifest_to_the_checked_release() {
        let current = Version::parse("1.1.0").unwrap();
        for (installed, package) in [(true, INSTALLER), (false, PORTABLE)] {
            let update = release("v1.2.0")
                .into_update(&current, installed)
                .unwrap()
                .unwrap();
            assert_eq!(
                update.download_url,
                format!("{RELEASES}/download/v1.2.0/{package}")
            );
            assert_eq!(update.notes.as_deref(), Some("Release notes from GitHub"));
            assert_eq!(
                update.manifest_url,
                Some(format!("{RELEASES}/download/v1.2.0/latest.json"))
            );
        }
    }

    #[test]
    fn discovering_a_release_does_not_require_a_manifest_or_signature_attachment() {
        let current = Version::parse("1.1.0").unwrap();
        let mut api_release = release("v1.2.0");
        api_release
            .assets
            .retain(|asset| asset.name != "latest.json");
        let update = api_release.into_update(&current, true).unwrap().unwrap();
        assert_eq!(update.version, "1.2.0");
        assert!(update.manifest_url.is_none());
    }

    #[test]
    fn does_not_offer_missing_unfinished_or_mismatched_packages() {
        let current = Version::parse("1.1.0").unwrap();
        let mut missing = release("v1.2.0");
        missing.assets.retain(|asset| asset.name != INSTALLER);
        assert!(missing.into_update(&current, true).is_err());
        let mut unfinished = release("v1.2.0");
        unfinished.assets[0].state = "starter".into();
        assert!(unfinished.into_update(&current, true).is_err());
        let mut mismatched = release("v1.2.0");
        mismatched.assets[0].browser_download_url =
            format!("{RELEASES}/download/v1.3.0/{INSTALLER}");
        assert!(mismatched.into_update(&current, true).is_err());
    }

    // Serve exactly one request; following any attachment during discovery would fail the test.
    fn mock_response(status: u16, body: &str) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}/releases/latest", listener.local_addr().unwrap());
        let body = body.to_owned();
        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "No release API request received");
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("{error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                let count = stream.read(&mut buffer).unwrap();
                assert!(count > 0 && request.len() < 16384);
                request.extend_from_slice(&buffer[..count]);
            }
            write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (endpoint, handle)
    }

    #[test]
    fn check_only_requests_the_release_api_and_uses_its_metadata() {
        let body = serde_json::json!({
            "tag_name": "v1.2.0", "body": "API release notes", "draft": false, "prerelease": false,
            "assets": [{ "name": INSTALLER, "state": "uploaded",
                "browser_download_url": format!("{RELEASES}/download/v1.2.0/{INSTALLER}") },
                { "name": "latest.json", "state": "uploaded",
                "browser_download_url": format!("{RELEASES}/download/v1.2.0/latest.json") }]
        });
        let (endpoint, server) = mock_response(200, &body.to_string());
        let current = Version::parse("1.1.0").unwrap();
        let update = tauri::async_runtime::block_on(check_endpoint(
            &client(&current).unwrap(),
            &endpoint,
            &current,
            true,
        ))
        .unwrap()
        .unwrap();
        assert_eq!(update.version, "1.2.0");
        assert_eq!(update.notes.as_deref(), Some("API release notes"));
        let request = server.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /releases/latest http/1.1\r\n"));
        assert!(request.contains("user-agent: weblink/1.1.0\r\n"));
        assert!(request.contains("accept: application/vnd.github+json\r\n"));
        assert!(request.contains("x-github-api-version: 2022-11-28\r\n"));
        assert!(!request.contains("authorization:"));
    }

    #[test]
    fn no_release_is_current_but_http_and_response_errors_are_not() {
        let current = Version::parse("1.1.0").unwrap();
        for (status, body) in [
            (404, "{}"),
            (403, "{}"),
            (429, "{}"),
            (500, "{}"),
            (200, "{}"),
            (200, "not json"),
        ] {
            let (endpoint, server) = mock_response(status, body);
            let result = tauri::async_runtime::block_on(check_endpoint(
                &client(&current).unwrap(),
                &endpoint,
                &current,
                true,
            ));
            server.join().unwrap();
            if status == 404 {
                assert!(result.unwrap().is_none());
            } else {
                assert!(
                    result.is_err(),
                    "status {status} with {body} must not report up to date"
                );
            }
        }
    }
}
