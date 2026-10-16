use super::*;
use std::io::{Read, Seek, SeekFrom};
use tauri::http::{Request, Response};

fn range(value: &str, size: u64) -> Option<(u64, u64)> {
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') || size == 0 {
        return None;
    }
    let (start, end) = value.split_once('-')?;
    if start.is_empty() {
        let count = end.parse::<u64>().ok()?;
        return (count > 0).then_some((size.saturating_sub(count), size - 1));
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        size - 1
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end && start < size).then_some((start, end))
}
pub fn respond(app: &tauri::AppHandle, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let response = || -> Result<Response<Vec<u8>>, String> {
        if request.method() != "GET" && request.method() != "HEAD" {
            return Err("Unsupported method".into());
        }
        let id = request.uri().path().trim_matches('/');
        let media = app
            .state::<Service>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .media
            .get(id)
            .cloned()
            .ok_or("Unknown file capability")?;
        let path = scoped(&media.root, &media.path, false)?;
        let before = stat(&path)?.ok_or("File is unavailable")?;
        if before.kind != "file" || before.revision != media.revision {
            return Err("File changed".into());
        }
        let base = Response::builder()
            .header("Access-Control-Allow-Origin", "*")
            .header("Accept-Ranges", "bytes")
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff")
            .header(
                "Content-Type",
                if media.mime.is_empty() {
                    "application/octet-stream"
                } else {
                    &media.mime
                },
            );
        let requested = request
            .headers()
            .get("range")
            .and_then(|value| value.to_str().ok());
        let (start, length, base) = if let Some(value) = requested {
            let Some((start, end)) = range(value, before.size) else {
                return base
                    .status(416)
                    .header("Content-Range", format!("bytes */{}", before.size))
                    .body(Vec::new())
                    .map_err(|e| e.to_string());
            };
            let end = end.min(start.saturating_add(8 * 1024 * 1024 - 1));
            (
                start,
                end - start + 1,
                base.status(206).header(
                    "Content-Range",
                    format!("bytes {start}-{end}/{}", before.size),
                ),
            )
        } else {
            (0, before.size, base.status(200))
        };
        let mut bytes = Vec::new();
        if request.method() != "HEAD" {
            let mut file = fs::File::open(&path).map_err(|e| e.to_string())?;
            file.seek(SeekFrom::Start(start))
                .map_err(|e| e.to_string())?;
            file.take(length)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() as u64 != length
                || stat(&path)?.is_none_or(|after| after.revision != before.revision)
            {
                return Err("File changed while reading".into());
            }
        }
        base.header("Content-Length", length)
            .body(bytes)
            .map_err(|e| e.to_string())
    };
    response().unwrap_or_else(|_| {
        Response::builder()
            .status(404)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_only_valid_single_ranges() {
        assert_eq!(range("bytes=2-4", 10), Some((2, 4)));
        assert_eq!(range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(range("bytes=8-", 10), Some((8, 9)));
        for value in ["bytes=10-", "bytes=4-2", "bytes=-0", "bytes=1-2,4-5"] {
            assert_eq!(range(value, 10), None);
        }
    }
}
