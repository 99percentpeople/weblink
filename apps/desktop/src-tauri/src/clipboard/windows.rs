use super::*;
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND},
        System::{DataExchange::*, Memory::*},
        UI::Shell::{DragQueryFileW, HDROP},
    },
};
const TEXT: u32 = 13;
const DROP: u32 = 15;
const DIB: u32 = 8;
use std::sync::atomic::Ordering;
use windows::Win32::UI::WindowsAndMessaging::*;
pub struct Watcher {
    id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Watcher {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.id, WM_QUIT, Default::default(), Default::default());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
pub fn watch(changed: Box<dyn Fn() + Send>) -> Result<Watcher, String> {
    listen(Box::new(move || {
        if !WRITING.load(Ordering::Acquire) && sequence() != LAST_WRITE.load(Ordering::Acquire) {
            changed();
        }
    }))
}
pub fn wait_after(after: u32, timeout: Duration) -> Result<(), String> {
    // Copy completion must see every sequence change, including local writes;
    // continuous sync's echo suppression applies only to watch(), not this wait.
    changes::wait_for_sequence(after, timeout, sequence, listen)
}
fn listen(changed: Box<dyn Fn() + Send>) -> Result<Watcher, String> {
    let (send, recv) = std::sync::mpsc::sync_channel(1);
    let thread = std::thread::Builder::new()
        .name("weblink-clipboard".into())
        .spawn(move || unsafe {
            let hwnd = match CreateWindowExW(
                Default::default(),
                windows::core::w!("STATIC"),
                windows::core::w!("Weblink clipboard"),
                Default::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            ) {
                Ok(hwnd) => hwnd,
                Err(e) => {
                    let _ = send.send(Err(e.to_string()));
                    return;
                }
            };
            if let Err(e) = AddClipboardFormatListener(hwnd) {
                let _ = DestroyWindow(hwnd);
                let _ = send.send(Err(e.to_string()));
                return;
            }
            let _ = send.send(Ok(windows::Win32::System::Threading::GetCurrentThreadId()));
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                if message.message == WM_CLIPBOARDUPDATE {
                    changed();
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        })
        .map_err(|e| e.to_string())?;
    match recv.recv().map_err(|e| e.to_string())? {
        Ok(id) => Ok(Watcher {
            id,
            thread: Some(thread),
        }),
        Err(e) => {
            let _ = thread.join();
            Err(e)
        }
    }
}
fn format(name: &str) -> u32 {
    let wide: Vec<_> = name.encode_utf16().chain(Some(0)).collect();
    unsafe { RegisterClipboardFormatW(PCWSTR(wide.as_ptr())) }
}
pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}
struct Open;
impl Open {
    fn new(hwnd: usize) -> Result<Self, String> {
        // Clipboard contention is normal (e.g. an application is still completing Copy).
        for _ in 0..10 {
            if unsafe { OpenClipboard(Some(HWND(hwnd as *mut _))) }.is_ok() {
                return Ok(Self);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err("Clipboard is busy; try again".into())
    }
}
impl Drop for Open {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}
fn get(id: u32) -> Result<Option<Vec<u8>>, String> {
    unsafe {
        if IsClipboardFormatAvailable(id).is_err() {
            return Ok(None);
        }
        let handle = GetClipboardData(id).map_err(|e| e.to_string())?;
        let mem = HGLOBAL(handle.0);
        let len = GlobalSize(mem);
        if len > LIMIT {
            return Err("Clipboard content exceeds 64 MiB".into());
        }
        let ptr = GlobalLock(mem);
        if ptr.is_null() {
            return Err("Cannot read clipboard".into());
        }
        let data = std::slice::from_raw_parts(ptr.cast::<u8>(), len).to_vec();
        let _ = GlobalUnlock(mem);
        Ok(Some(data))
    }
}
pub fn read() -> Result<(Snapshot, Vec<String>), String> {
    let _open = Open::new(0)?;
    let mut entries = Vec::new();
    let mut paths = Vec::new();
    if let Some(data) = get(TEXT)? {
        let wide: Vec<_> = data
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|v| *v != 0)
            .collect();
        entries.push(Entry::bytes(
            "text/plain",
            String::from_utf16_lossy(&wide).as_bytes(),
        ));
    }
    for (name, kind) in [
        ("HTML Format", "text/html"),
        ("Rich Text Format", "text/rtf"),
    ] {
        if let Some(mut data) = get(format(name))? {
            while data.last() == Some(&0) {
                data.pop();
            }
            if kind == "text/html" {
                data = html_fragment(&data)?;
            }
            entries.push(Entry::bytes(kind, &data));
        }
    }
    if let Some(data) = get(format("PNG"))? {
        entries.push(Entry::bytes("image/png", &data));
    } else if let Some(data) = get(DIB)? {
        entries.push(Entry::bytes("image/png", &dib_png(&data)?));
    }
    unsafe {
        if IsClipboardFormatAvailable(DROP).is_ok() {
            let handle = HDROP(GetClipboardData(DROP).map_err(|e| e.to_string())?.0);
            let count = DragQueryFileW(handle, u32::MAX, None);
            if count > MAX_ENTRIES as u32 {
                return Err("Too many clipboard files".into());
            }
            for i in 0..count {
                let len = DragQueryFileW(handle, i, None) as usize;
                if len > 32767 {
                    return Err("Clipboard path is too long".into());
                }
                let mut path = vec![0u16; len + 1];
                DragQueryFileW(handle, i, Some(&mut path));
                paths.push(String::from_utf16(&path[..len]).map_err(|e| e.to_string())?);
            }
        }
    }
    let size: usize = entries.iter().map(|e| e.data.len() * 3 / 4).sum();
    if size > LIMIT {
        return Err("Clipboard content exceeds 64 MiB".into());
    }
    Ok((
        Snapshot {
            sequence: sequence(),
            entries,
        },
        paths,
    ))
}
fn html_fragment(data: &[u8]) -> Result<Vec<u8>, String> {
    let header = String::from_utf8_lossy(&data[..data.len().min(4096)]);
    let offset = |key: &str| {
        header
            .lines()
            .find_map(|line| line.strip_prefix(key)?.trim().parse::<usize>().ok())
    };
    match (offset("StartFragment:"), offset("EndFragment:")) {
        (Some(start), Some(end)) if start <= end && end <= data.len() => {
            Ok(data[start..end].to_vec())
        }
        _ => Err("Invalid HTML clipboard offsets".into()),
    }
}
fn html_format(data: Vec<u8>) -> Result<Vec<u8>, String> {
    let fragment = String::from_utf8(data).map_err(|e| e.to_string())?;
    let prefix = "<html><body><!--StartFragment-->";
    let suffix = "<!--EndFragment--></body></html>";
    let header = |start: usize, end: usize, a: usize, b: usize| {
        format!("Version:1.0\r\nStartHTML:{start:010}\r\nEndHTML:{end:010}\r\nStartFragment:{a:010}\r\nEndFragment:{b:010}\r\n")
    };
    let start = header(0, 0, 0, 0).len();
    let a = start + prefix.len();
    let b = a + fragment.len();
    Ok(format!(
        "{}{prefix}{fragment}{suffix}\0",
        header(start, b + suffix.len(), a, b)
    )
    .into_bytes())
}
pub fn encode(kind: &str, data: Vec<u8>) -> Result<Vec<(u32, Vec<u8>)>, String> {
    Ok(match kind {
        "text/plain" => vec![(
            TEXT,
            String::from_utf8(data)
                .map_err(|e| e.to_string())?
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect(),
        )],
        "text/html" => vec![(format("HTML Format"), html_format(data)?)],
        "text/rtf" => {
            let mut data = data;
            data.push(0);
            vec![(format("Rich Text Format"), data)]
        }
        "image/png" => vec![(DIB, png_dib(&data)?), (format("PNG"), data)],
        _ => return Err("Unsupported clipboard format".into()),
    })
}
pub fn files(paths: &[String]) -> Result<(u32, Vec<u8>), String> {
    // DROPFILES header: offset=20, wide=true; double-NUL terminated UTF-16 list.
    let mut data = vec![0u8; 20];
    data[0] = 20;
    data[16] = 1;
    for path in paths {
        data.extend(
            path.encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes),
        );
    }
    data.extend([0, 0]);
    Ok((DROP, data))
}
pub fn write(hwnd: usize, formats: Vec<(u32, Vec<u8>)>) -> Result<u32, String> {
    struct Writing;
    impl Drop for Writing {
        fn drop(&mut self) {
            LAST_WRITE.store(sequence(), Ordering::Release);
            WRITING.store(false, Ordering::Release);
        }
    }
    // Allocate everything before EmptyClipboard, so malformed/oversized input preserves old contents.
    struct Allocation(HGLOBAL);
    impl Drop for Allocation {
        fn drop(&mut self) {
            if !self.0 .0.is_null() {
                unsafe {
                    let _ = GlobalFree(Some(self.0));
                }
            }
        }
    }
    let mut allocated = Vec::new();
    for (id, data) in formats {
        if id == 0 {
            return Err("Cannot register clipboard format".into());
        }
        let mem = Allocation(
            unsafe { GlobalAlloc(GMEM_MOVEABLE, data.len().max(1)) }.map_err(|e| e.to_string())?,
        );
        unsafe {
            let ptr = GlobalLock(mem.0);
            if ptr.is_null() {
                return Err("Cannot allocate clipboard".into());
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr.cast::<u8>(), data.len());
            let _ = GlobalUnlock(mem.0);
        }
        allocated.push((id, mem));
    }
    WRITING.store(true, Ordering::Release);
    let _writing = Writing;
    let _open = Open::new(hwnd)?;
    unsafe {
        EmptyClipboard().map_err(|e| e.to_string())?;
        for (id, mut mem) in allocated {
            SetClipboardData(id, Some(HANDLE(mem.0 .0))).map_err(|e| e.to_string())?;
            mem.0 = HGLOBAL(std::ptr::null_mut());
        }
    }
    drop(_open);
    drop(_writing);
    Ok(sequence())
}
fn u32_at(data: &[u8], offset: usize) -> Result<u32, String> {
    Ok(u32::from_le_bytes(
        data.get(offset..offset + 4)
            .ok_or("Invalid clipboard image")?
            .try_into()
            .unwrap(),
    ))
}
fn dib_png(data: &[u8]) -> Result<Vec<u8>, String> {
    let header = u32_at(data, 0)? as usize;
    let width = u32_at(data, 4)? as i32;
    let height = u32_at(data, 8)? as i32;
    let bits =
        u16::from_le_bytes(data.get(14..16).ok_or("Invalid image")?.try_into().unwrap()) as usize;
    let compression = u32_at(data, 16)?;
    if header < 40
        || width <= 0
        || height == 0
        || height == i32::MIN
        || ![24, 32].contains(&bits)
        || ![0, 3, 6].contains(&compression)
        || (compression != 0 && bits != 32)
        || u32_at(data, 32)? != 0
    {
        return Err("Unsupported clipboard bitmap".into());
    }
    let w = width as usize;
    let h = height.unsigned_abs() as usize;
    let size = w
        .checked_mul(h)
        .and_then(|n| n.checked_mul(4))
        .filter(|n| *n <= LIMIT)
        .ok_or("Clipboard image exceeds 64 MiB")?;
    let stride = (w * bits).div_ceil(32) * 4;
    let offset = if header == 40 && compression != 0 {
        header + if compression == 6 { 16 } else { 12 }
    } else {
        header
    };
    let masks = if compression != 0 {
        [
            u32_at(data, 40)?,
            u32_at(data, 44)?,
            u32_at(data, 48)?,
            if header >= 56 || compression == 6 {
                u32_at(data, 52)?
            } else {
                0
            },
        ]
    } else {
        [0x00ff0000, 0x0000ff00, 0x000000ff, 0]
    };
    if offset
        .checked_add(stride * h)
        .is_none_or(|n| n > data.len())
    {
        return Err("Truncated clipboard image".into());
    }
    let mut rgba = vec![0; size];
    for y in 0..h {
        for x in 0..w {
            let source =
                offset + (if height > 0 { h - 1 - y } else { y }) * stride + x * (bits / 8);
            let target = (y * w + x) * 4;
            let pixel = u32::from_le_bytes([
                data[source],
                data[source + 1],
                data[source + 2],
                if bits == 32 { data[source + 3] } else { 0 },
            ]);
            for (channel, mask) in masks.iter().enumerate() {
                rgba[target + channel] = if *mask == 0 {
                    if channel == 3 {
                        255
                    } else {
                        0
                    }
                } else {
                    let shift = mask.trailing_zeros();
                    ((((pixel & mask) >> shift) as u64 * 255) / (mask >> shift) as u64) as u8
                };
            }
        }
    }
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, w as u32, h as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .map_err(|e| e.to_string())?
        .write_image_data(&rgba)
        .map_err(|e| e.to_string())?;
    Ok(out)
}
fn png_dib(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(data));
    decoder.set_limits(png::Limits { bytes: LIMIT });
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let size = reader
        .output_buffer_size()
        .filter(|s| *s <= LIMIT)
        .ok_or("Clipboard image exceeds 64 MiB")?;
    let mut pixels = vec![0; size];
    let info = reader.next_frame(&mut pixels).map_err(|e| e.to_string())?;
    let bytes = (info.width as usize)
        .checked_mul(info.height as usize)
        .and_then(|v| v.checked_mul(4))
        .filter(|n| *n <= LIMIT - 40)
        .ok_or("Clipboard image exceeds 64 MiB")?;
    let mut dib = vec![0u8; 40 + bytes];
    dib[0..4].copy_from_slice(&40u32.to_le_bytes());
    dib[4..8].copy_from_slice(&info.width.to_le_bytes());
    dib[8..12].copy_from_slice(&(-(info.height as i32)).to_le_bytes());
    dib[12] = 1;
    dib[14] = 32;
    let channels = info.color_type.samples();
    for (source, target) in pixels[..info.buffer_size()]
        .chunks_exact(channels)
        .zip(dib[40..].chunks_exact_mut(4))
    {
        let (r, g, b, a) = match info.color_type {
            png::ColorType::Rgba => (source[0], source[1], source[2], source[3]),
            png::ColorType::Rgb => (source[0], source[1], source[2], 255),
            png::ColorType::Grayscale => (source[0], source[0], source[0], 255),
            png::ColorType::GrayscaleAlpha => (source[0], source[0], source[0], source[1]),
            _ => return Err("Unsupported PNG image".into()),
        };
        target.copy_from_slice(&[b, g, r, a]);
    }
    Ok(dib)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clipboard_listener_dispatches_and_shuts_down_without_polling() {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let watcher = listen(Box::new(move || {
            let _ = send.try_send(());
        }))
        .unwrap();
        // Exercise our real Windows message pump without replacing user clipboard data.
        unsafe {
            PostThreadMessageW(
                watcher.id,
                WM_CLIPBOARDUPDATE,
                Default::default(),
                Default::default(),
            )
        }
        .unwrap();
        receive.recv_timeout(Duration::from_secs(2)).unwrap();
        drop(watcher);
        assert!(matches!(
            receive.recv_timeout(Duration::from_secs(1)),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        ));
    }
    #[test]
    fn clipboard_png_and_bitmap_round_trip() {
        let mut png = Vec::new();
        let mut encoder = png::Encoder::new(&mut png, 2, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[255, 0, 0, 0, 128, 255])
            .unwrap();
        let dib = png_dib(&png).unwrap();
        let restored = dib_png(&dib).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(restored))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut pixels).unwrap();
        assert_eq!(pixels, [255, 0, 0, 255, 0, 128, 255, 255]);
    }
    #[test]
    fn clipboard_rejects_huge_bitmaps_before_allocating() {
        let mut data = vec![0u8; 40];
        data[..4].copy_from_slice(&40u32.to_le_bytes());
        data[4..8].copy_from_slice(&100000u32.to_le_bytes());
        data[8..12].copy_from_slice(&100000u32.to_le_bytes());
        data[14] = 32;
        assert!(dib_png(&data).unwrap_err().contains("64 MiB"));
    }
    #[test]
    fn html_offsets_are_utf8_bytes() {
        let text = "<b>中文🧪</b>";
        assert_eq!(
            html_fragment(&html_format(text.as_bytes().to_vec()).unwrap()).unwrap(),
            text.as_bytes()
        );
    }
    #[test]
    fn rejects_truncated_bitmap() {
        assert!(dib_png(&[0; 20]).is_err());
    }
}
