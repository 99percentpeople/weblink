//! Bounded recent output with absolute cursors across stdout/stderr.
use base64::Engine;
use serde_json::{json, Value};
use std::collections::VecDeque;

pub(super) const LIMIT: usize = 4 * 1024 * 1024;
const SEGMENT_LIMIT: usize = 8192;
const PAGE: usize = 16384;
const MAX_CURSOR: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy)]
pub(super) enum Read {
    Cursor(u64),
    TailBytes(usize),
    TailLines(usize),
}
impl Default for Read {
    fn default() -> Self {
        Self::TailBytes(PAGE)
    }
}
impl Read {
    pub fn parse(args: &Value) -> Result<Self, String> {
        let mut selected = None;
        for (name, limit) in [
            ("cursor", MAX_CURSOR),
            ("tailBytes", PAGE as u64),
            ("tailLines", 1000),
        ] {
            if let Some(value) = args.get(name) {
                let n = value.as_u64().ok_or("INVALID_ARGUMENTS")?;
                if selected.is_some() || n > limit || (name != "cursor" && n == 0) {
                    return Err("INVALID_ARGUMENTS".into());
                }
                selected = Some(match name {
                    "cursor" => Self::Cursor(n),
                    "tailBytes" => Self::TailBytes(n as usize),
                    _ => Self::TailLines(n as usize),
                });
            }
        }
        Ok(selected.unwrap_or_default())
    }
}

struct Segment {
    start: u64,
    end: u64,
    stream: &'static str,
}
#[derive(Default)]
pub(super) struct Output {
    data: VecDeque<u8>,
    segments: VecDeque<Segment>,
    start: u64,
    end: u64,
}
impl Output {
    pub fn truncated(&self) -> bool {
        self.start != 0
    }
    fn discard_before(&mut self, start: u64) {
        debug_assert!((self.start..=self.end).contains(&start));
        self.data.drain(..(start - self.start) as usize);
        while self.segments.front().is_some_and(|s| s.end <= start) {
            self.segments.pop_front();
        }
        if let Some(first) = self.segments.front_mut() {
            first.start = first.start.max(start);
        }
        self.start = start;
    }
    pub fn append(&mut self, data: &[u8], stream: &'static str) {
        if data.is_empty() {
            return;
        }
        let end = self.end + data.len() as u64;
        let start = self.start.max(end.saturating_sub(LIMIT as u64));
        // Discard before appending so the ring never exceeds its byte bound.
        self.discard_before(start.min(self.end));
        let skip = start.saturating_sub(self.end) as usize;
        self.data.extend(&data[skip..]);
        if let Some(last) = self.segments.back_mut().filter(|s| s.stream == stream) {
            last.end = end;
        } else {
            self.segments.push_back(Segment {
                start: self.end + skip as u64,
                end,
                stream,
            });
        }
        self.start = start;
        self.end = end;
        while self.segments.len() > SEGMENT_LIMIT {
            self.discard_before(self.segments.front().unwrap().end);
        }
        debug_assert_eq!(self.data.len() as u64, self.end - self.start);
    }
    pub fn metadata(&self) -> Value {
        json!({
            "bytes": self.end,
            "retainedBytes": self.data.len(),
            "earliestCursor": self.start,
            "truncated": self.truncated(),
        })
    }
    fn lines_start(&self, mut lines: usize) -> u64 {
        // LF-delimited combined output. A final LF terminates the last line;
        // it does not create a new empty line. CRLF bytes remain unchanged.
        for (offset, &byte) in self.data.iter().enumerate().rev() {
            if byte == b'\n' && offset + 1 < self.data.len() {
                lines -= 1;
                if lines == 0 {
                    return self.start + offset as u64 + 1;
                }
            }
        }
        self.start
    }
    pub fn read(&self, read: Read) -> Result<Value, String> {
        let mut cursor_expired = false;
        let mut tail_limited = false;
        let start = match read {
            Read::Cursor(cursor) => {
                if cursor > self.end {
                    return Err("INVALID_ARGUMENTS".into());
                }
                cursor_expired = cursor < self.start;
                cursor.max(self.start)
            }
            Read::TailBytes(bytes) => self.end.saturating_sub(bytes as u64).max(self.start),
            Read::TailLines(lines) => {
                let wanted = self.lines_start(lines);
                let bounded = self.end.saturating_sub(PAGE as u64).max(wanted);
                tail_limited = bounded > wanted;
                bounded
            }
        };
        let end = (start + PAGE as u64).min(self.end);
        let chunks: Vec<_> = self
            .segments
            .iter()
            .filter_map(|segment| {
                let a = segment.start.max(start);
                let b = segment.end.min(end);
                if a >= b {
                    return None;
                }
                let data: Vec<u8> = self
                    .data
                    .range((a - self.start) as usize..(b - self.start) as usize)
                    .copied()
                    .collect();
                Some(json!({"stream":segment.stream,
                "data":String::from_utf8_lossy(&data),
                "dataBase64":base64::engine::general_purpose::STANDARD.encode(&data)}))
            })
            .collect();
        let mut result = self.metadata();
        result.as_object_mut().unwrap().extend(
            json!({"chunks":chunks,"startCursor":start,"nextCursor":end,
                "hasMore":end < self.end,"cursorExpired":cursor_expired,
                "tailLimited":tail_limited})
            .as_object()
            .unwrap()
            .clone(),
        );
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
