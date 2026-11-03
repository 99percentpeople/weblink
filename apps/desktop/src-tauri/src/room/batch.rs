// Local WebView IPC framing. Validate the whole envelope before sending any
// message, then borrow each payload directly from the Tauri request.
const MAX_BYTES: usize = 256 * 1024;
const MAX_MESSAGES: usize = 32;

pub(super) fn write(
    mut frame: &[u8],
    mut send: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<usize, String> {
    if frame.len() > MAX_BYTES {
        return Err("Room write batch too large".into());
    }
    let mut packets: [&[u8]; MAX_MESSAGES] = [&[]; MAX_MESSAGES];
    let mut count = 0;
    while !frame.is_empty() {
        let (length, rest) = frame
            .split_first_chunk::<4>()
            .ok_or("Invalid room batch header")?;
        let size = u32::from_le_bytes(*length) as usize;
        if count == MAX_MESSAGES || size == 0 || size > rest.len() {
            return Err("Invalid room batch packet".into());
        }
        (packets[count], frame) = rest.split_at(size);
        count += 1;
    }
    if count < 2 {
        return Err("Expected multiple room packets".into());
    }
    let mut accepted = 0;
    for packet in &packets[..count] {
        if let Err(error) = send(packet) {
            return if accepted == 0 {
                Err(error)
            } else {
                Ok(accepted)
            };
        }
        accepted += packet.len();
    }
    Ok(accepted)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO: &[u8] = &[2, 0, 0, 0, 0x80, 0xff, 1, 0, 0, 0, 7];

    #[test]
    fn preserves_boundaries_and_reports_only_accepted_bytes() {
        let mut delivered = Vec::new();
        assert_eq!(
            write(TWO, |p| {
                delivered.push(p.to_vec());
                Ok(())
            }),
            Ok(3)
        );
        assert_eq!(delivered, [vec![0x80, 0xff], vec![7]]);
        assert_eq!(
            write(TWO, |p| if p == [7] {
                Err("closed".into())
            } else {
                Ok(())
            }),
            Ok(2)
        );
        assert_eq!(write(TWO, |_| Err("closed".into())), Err("closed".into()));
    }

    #[test]
    fn rejects_invalid_envelopes_before_sending_the_prefix() {
        let too_many = [1, 0, 0, 0, 42].repeat(MAX_MESSAGES + 1);
        for data in [
            vec![],
            TWO[..6].to_vec(),
            TWO[..10].to_vec(),
            [TWO, &[0, 0, 0, 0]].concat(),
            [TWO, &[1]].concat(),
            too_many,
            vec![0; MAX_BYTES + 1],
        ] {
            assert!(write(&data, |_| panic!("invalid frame was partly sent")).is_err());
        }
    }
}
