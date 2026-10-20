use super::*;

fn bytes(page: &Value) -> Vec<u8> {
    page["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|chunk| {
            base64::engine::general_purpose::STANDARD
                .decode(chunk["dataBase64"].as_str().unwrap())
                .unwrap()
        })
        .collect()
}
fn read(output: &Output, args: Value) -> Value {
    output.read(Read::parse(&args).unwrap()).unwrap()
}

#[test]
fn defaults_to_recent_output_and_cursor_can_read_older_pages() {
    let mut output = Output::default();
    let empty = read(&output, json!({}));
    assert!(bytes(&empty).is_empty());
    assert_eq!(empty["nextCursor"], 0);
    assert_eq!(empty["cursorExpired"], false);
    output.append(&vec![b'a'; PAGE + 100], "stdout");
    output.append(b"final error\n", "stderr");
    let tail = read(&output, json!({}));
    assert_eq!(bytes(&tail).len(), PAGE);
    assert!(bytes(&tail).ends_with(b"final error\n"));
    assert_eq!(tail["startCursor"], 112);
    assert_eq!(tail["nextCursor"], output.end);
    assert_eq!(tail["hasMore"], false);
    // Intentionally selecting the tail is not cache eviction.
    assert_eq!(tail["truncated"], false);
    assert_eq!(tail["cursorExpired"], false);
    let head = read(&output, json!({"cursor":0}));
    assert_eq!(head["startCursor"], 0);
    assert_eq!(head["hasMore"], true);
    assert_eq!(bytes(&head), vec![b'a'; PAGE]);
    let small = read(&output, json!({"tailBytes":12}));
    assert_eq!(bytes(&small), b"final error\n");
    output.append(b"new output", "stdout");
    let next = read(&output, json!({"cursor":tail["nextCursor"]}));
    assert_eq!(bytes(&next), b"new output");
    assert_eq!(next["hasMore"], false);
}

#[test]
fn byte_eviction_keeps_latest_output_and_reports_expired_cursors() {
    let mut output = Output::default();
    output.append(&vec![b'a'; LIMIT - 4], "stdout");
    output.append(b"BBBB", "stderr");
    let caught_up = read(&output, json!({}))["nextCursor"].as_u64().unwrap();
    output.append(b"last error", "stderr");
    assert_eq!(output.data.len(), LIMIT);
    assert_eq!(output.segments.len(), 2);
    let status = output.metadata();
    assert_eq!(status["bytes"], LIMIT + 10);
    assert_eq!(status["earliestCursor"], 10);
    assert_eq!(status["truncated"], true);
    let stale = read(&output, json!({"cursor":3}));
    assert_eq!(stale["cursorExpired"], true);
    assert_eq!(stale["startCursor"], 10);
    assert_eq!(stale["nextCursor"], 10 + PAGE);
    let fresh = read(&output, json!({"cursor":caught_up}));
    assert_eq!(fresh["cursorExpired"], false);
    assert_eq!(fresh["truncated"], true);
    assert_eq!(bytes(&fresh), b"last error");
    assert_eq!(fresh["chunks"][0]["stream"], "stderr");
    assert_eq!(read(&output, json!({"cursor":10}))["cursorExpired"], false);
    assert!(output.read(Read::Cursor(output.end + 1)).is_err());
    assert!(bytes(&read(&output, json!({"cursor":output.end}))).is_empty());
}

#[test]
fn large_appends_and_repeated_ring_wraps_preserve_absolute_offsets() {
    let mut output = Output::default();
    output.append(b"old", "stderr");
    let data: Vec<u8> = (0..LIMIT + 99).map(|i| (i % 251) as u8).collect();
    output.append(&data, "stdout");
    assert_eq!(output.data.len(), LIMIT);
    assert_eq!(output.start, 102);
    assert_eq!(output.segments.len(), 1);
    assert_eq!(bytes(&read(&output, json!({}))), data[data.len() - PAGE..]);
    for n in 0..600 {
        output.append(&vec![(n % 251) as u8; 8192], "stdout");
    }
    assert_eq!(output.data.len(), LIMIT);
    assert_eq!(output.end, 3 + data.len() as u64 + 600 * 8192);
    assert_eq!(output.start, output.end - LIMIT as u64);
    let tail = bytes(&read(&output, json!({})));
    assert_eq!(&tail[..8192], &vec![(598 % 251) as u8; 8192]);
    assert_eq!(&tail[8192..], &vec![(599 % 251) as u8; 8192]);
}

#[test]
fn segment_limit_evicts_oldest_streams_and_continues_accepting_new_output() {
    let mut output = Output::default();
    for i in 0..SEGMENT_LIMIT + 7 {
        output.append(
            &[(i % 251) as u8],
            if i % 2 == 0 { "stdout" } else { "stderr" },
        );
    }
    assert_eq!(output.segments.len(), SEGMENT_LIMIT);
    assert_eq!(output.data.len(), SEGMENT_LIMIT);
    assert_eq!(output.start, 7);
    let stale = read(&output, json!({"cursor":0}));
    assert_eq!(stale["cursorExpired"], true);
    assert_eq!(
        bytes(&stale),
        (7..SEGMENT_LIMIT + 7)
            .map(|i| (i % 251) as u8)
            .collect::<Vec<_>>()
    );
    assert_eq!(stale["chunks"][0]["stream"], "stderr");
    let before = output.end;
    // Merge even when already at the segment limit.
    output.append(b"merged", "stdout");
    assert_eq!(output.segments.len(), SEGMENT_LIMIT);
    assert_eq!(output.start, 7);
    output.append(b"latest", "stderr");
    assert_eq!(output.start, 8);
    assert_eq!(
        bytes(&read(&output, json!({"cursor":before}))),
        b"mergedlatest"
    );
}

#[test]
fn tail_lines_handles_lf_crlf_empty_lines_and_unterminated_last_line() {
    for (data, lines, expected) in [
        ("", 3, ""),
        ("one", 1, "one"),
        ("one\ntwo\nthree\n", 2, "two\nthree\n"),
        ("one\r\ntwo\r\n", 1, "two\r\n"),
        ("one\ntwo", 1, "two"),
        ("one\n\n", 1, "\n"),
        ("\n", 2, "\n"),
        ("one\ntwo", 1000, "one\ntwo"),
    ] {
        let mut output = Output::default();
        // Delimiters and characters can cross pipe/stream segments.
        for (i, byte) in data.as_bytes().iter().enumerate() {
            output.append(&[*byte], if i % 2 == 0 { "stdout" } else { "stderr" });
        }
        let page = read(&output, json!({"tailLines":lines}));
        assert_eq!(bytes(&page), expected.as_bytes());
        assert_eq!(page["tailLimited"], false);
        assert_eq!(page["hasMore"], false);
    }
    let mut output = Output::default();
    output.append(&vec![b'x'; PAGE + 1], "stdout");
    let long = read(&output, json!({"tailLines":1}));
    assert_eq!(bytes(&long).len(), PAGE);
    assert_eq!(long["startCursor"], 1);
    assert_eq!(long["tailLimited"], true);
    assert_eq!(long["truncated"], false);
}

#[test]
fn unicode_pages_preserve_exact_bytes_after_eviction() {
    let mut output = Output::default();
    output.append(&vec![b'!'; LIMIT], "stderr");
    let data = "你🙂".repeat(6000).into_bytes();
    output.append(&data, "stdout");
    let mut cursor = LIMIT as u64;
    let mut actual = vec![];
    loop {
        let page = read(&output, json!({"cursor":cursor}));
        actual.extend(bytes(&page));
        cursor = page["nextCursor"].as_u64().unwrap();
        if page["hasMore"] == false {
            break;
        }
    }
    assert_eq!(actual, data);
    assert_eq!(
        bytes(&read(&output, json!({"tailBytes":8}))),
        data[data.len() - 8..]
    );
}

#[test]
fn read_modes_reject_ambiguous_malformed_and_unbounded_requests() {
    for args in [
        json!({"cursor":0,"tailBytes":4}),
        json!({"tailBytes":4,"tailLines":2}),
        json!({"cursor":0,"tailLines":2}),
        json!({"tailBytes":0}),
        json!({"tailBytes":PAGE+1}),
        json!({"tailLines":0}),
        json!({"tailLines":1001}),
        json!({"tailLines":1.5}),
        json!({"cursor":-1}),
        json!({"cursor":null}),
        json!({"cursor":MAX_CURSOR+1}),
        json!({"cursor":"3"}),
    ] {
        assert!(Read::parse(&args).is_err(), "{args}");
    }
    assert!(Read::parse(&json!({"cursor":LIMIT+100})).is_ok());
    assert!(Read::parse(&json!({"cursor":MAX_CURSOR})).is_ok());
}
