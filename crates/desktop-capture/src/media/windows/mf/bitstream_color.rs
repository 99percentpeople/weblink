//! Keep SPS colour descriptions consistent with converted pixels and RTP metadata.
//!
//! Some MF drivers accept the media type but emit a reserved transfer function or
//! ignore full range. Only SPS VUI colour bits change; picture data, reference
//! lists and timing are retained. Syntax follows H.264/H.265 sections 7.3 and E.1.
use crate::media::color::ColorDescription;
use libwebrtc::video_frame::EncodedVideoCodec;

type Result<T> = std::result::Result<T, &'static str>;
const INVALID: &str = "Unsupported or truncated hardware SPS colour description";

/// Normalizes Annex B SPS units. Delta access units need no allocation or copy.
pub(super) fn normalize(
    bytes: &mut Vec<u8>,
    codec: EncodedVideoCodec,
    color: ColorDescription,
) -> Result<()> {
    let hevc = matches!(codec, EncodedVideoCodec::H265);
    let mut unit = next_unit(bytes, 0);
    while let Some((_, payload)) = unit {
        let Some(&header) = bytes.get(payload) else {
            return Err(INVALID);
        };
        let kind = if hevc {
            (header >> 1) & 63
        } else {
            header & 31
        };
        // One MF sample is one access unit. Its SPS precedes picture slices;
        // do not walk the large compressed picture payload on every frame.
        if if hevc {
            kind <= 31
        } else {
            (1..=5).contains(&kind)
        } {
            return Ok(());
        }
        let next = next_unit(bytes, payload);
        let end = next.map_or(bytes.len(), |v| v.0);
        let is_sps = kind == if hevc { 33 } else { 7 };
        if is_sps {
            let header_len = if hevc { 2 } else { 1 };
            let start = payload + header_len;
            let rbsp = bytes.get(start..end).ok_or(INVALID)?;
            let updated = rewrite_sps(rbsp, hevc, color)?;
            let next_start = start + updated.len();
            bytes.splice(start..end, updated);
            unit = next_unit(bytes, next_start);
        } else {
            unit = next;
        }
    }
    Ok(())
}

fn next_unit(bytes: &[u8], from: usize) -> Option<(usize, usize)> {
    let start = from + bytes.get(from..)?.windows(3).position(|v| v == [0, 0, 1])?;
    Some((
        if start > from && bytes[start - 1] == 0 {
            start - 1
        } else {
            start
        },
        start + 3,
    ))
}

struct Bits {
    data: Vec<u8>,
    at: usize,
}
impl Bits {
    fn read(&mut self, count: usize) -> Result<u32> {
        if count > 32 {
            return Err(INVALID);
        }
        let end = self.at.checked_add(count).ok_or(INVALID)?;
        let slice = self.data.get(self.at..end).ok_or(INVALID)?;
        let value = slice.iter().fold(0, |v, b| (v << 1) | u32::from(*b));
        self.at = end;
        Ok(value)
    }
    fn skip(&mut self, count: usize) -> Result<()> {
        let end = self.at.checked_add(count).ok_or(INVALID)?;
        self.data.get(self.at..end).ok_or(INVALID)?;
        self.at = end;
        Ok(())
    }
    fn flag(&mut self) -> Result<bool> {
        Ok(self.read(1)? != 0)
    }
    fn ue(&mut self, max: u32) -> Result<u32> {
        let mut zeros = 0;
        while !self.flag()? {
            zeros += 1;
            if zeros > 30 {
                return Err(INVALID);
            }
        }
        let value = (1 << zeros) - 1 + self.read(zeros)?;
        if value > max {
            return Err(INVALID);
        }
        Ok(value)
    }
    fn ues(&mut self, count: usize) -> Result<()> {
        for _ in 0..count {
            self.ue(u32::MAX)?;
        }
        Ok(())
    }
}

fn unpack(bytes: &[u8]) -> Result<Bits> {
    if bytes.len() > 4096 {
        return Err(INVALID);
    }
    let mut data = Vec::with_capacity(bytes.len() * 8);
    let mut zeros = 0;
    for &byte in bytes {
        if zeros == 2 && byte == 3 {
            zeros = 0;
            continue;
        }
        for shift in (0..8).rev() {
            data.push((byte >> shift) & 1);
        }
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    // Preserve rbsp_stop_one_bit, rebuilding only byte alignment after insertion.
    let stop = data.iter().rposition(|b| *b != 0).ok_or(INVALID)?;
    data.truncate(stop + 1);
    Ok(Bits { data, at: 0 })
}

fn pack(mut data: Vec<u8>) -> Vec<u8> {
    data.resize(data.len().div_ceil(8) * 8, 0);
    let mut bytes = Vec::new();
    let mut zeros = 0;
    for bits in data.chunks_exact(8) {
        let byte = bits.iter().fold(0_u8, |v, b| (v << 1) | b);
        if zeros == 2 && byte <= 3 {
            bytes.push(3);
            zeros = 0;
        }
        bytes.push(byte);
        zeros = if byte == 0 { zeros + 1 } else { 0 };
    }
    bytes
}

fn rewrite_sps(bytes: &[u8], hevc: bool, color: ColorDescription) -> Result<Vec<u8>> {
    let mut bits = unpack(bytes)?;
    if hevc {
        skip_hevc_sps(&mut bits)?;
    } else {
        skip_h264_sps(&mut bits)?;
    }
    let vui_at = bits.at;
    let present = bits.flag()?;
    let (start, end) = if present {
        // Both codecs have the same aspect ratio, overscan and video signal prefix.
        if bits.flag()? && bits.read(8)? == 255 {
            bits.skip(32)?;
        }
        if bits.flag()? {
            bits.skip(1)?;
        }
        let start = bits.at;
        if bits.flag()? {
            bits.skip(4)?; // video_format and video_full_range_flag
            if bits.flag()? {
                bits.skip(24)?;
            }
        }
        (start, bits.at)
    } else {
        (vui_at, bits.at)
    };
    let mut replacement = Vec::new();
    if !present {
        replacement.extend([1, 0, 0]);
    } // VUI, no aspect ratio/overscan
    let color = color.rtc();
    replacement.extend([1, 1, 0, 1, u8::from(color.full_range), 1]);
    for byte in [color.primaries, color.transfer, color.matrix] {
        for shift in (0..8).rev() {
            replacement.push((byte >> shift) & 1);
        }
    }
    if !present {
        replacement.extend(vec![0; if hevc { 7 } else { 6 }]);
    }
    bits.data.splice(start..end, replacement);
    Ok(pack(bits.data))
}

fn skip_h264_sps(bits: &mut Bits) -> Result<()> {
    let profile = bits.read(8)?;
    bits.skip(16)?; // constraints and level
    bits.ue(31)?;
    if matches!(
        profile,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    ) {
        let chroma = bits.ue(3)?;
        if chroma == 3 {
            bits.skip(1)?;
        }
        bits.ues(2)?;
        bits.skip(1)?;
        if bits.flag()? {
            for list in 0..if chroma == 3 { 12 } else { 8 } {
                if bits.flag()? {
                    let (mut last, mut next) = (8_i64, 8_i64);
                    for _ in 0..if list < 6 { 16 } else { 64 } {
                        if next != 0 {
                            let code = i64::from(bits.ue(u32::MAX)?);
                            let delta = if code % 2 == 0 {
                                -code / 2
                            } else {
                                (code + 1) / 2
                            };
                            next = (last + delta).rem_euclid(256);
                        }
                        if next != 0 {
                            last = next;
                        }
                    }
                }
            }
        }
    } else if !matches!(profile, 66 | 77 | 88) {
        return Err(INVALID);
    }
    bits.ue(12)?;
    match bits.ue(2)? {
        0 => {
            bits.ue(12)?;
        }
        1 => {
            bits.skip(1)?;
            bits.ues(2)?; // signed Exp-Golomb has the same bit length
            let cycle = bits.ue(255)?;
            bits.ues(cycle as usize)?;
        }
        _ => {}
    }
    bits.ue(16)?;
    bits.skip(1)?;
    bits.ues(2)?;
    if !bits.flag()? {
        bits.skip(1)?;
    }
    bits.skip(1)?;
    if bits.flag()? {
        bits.ues(4)?;
    }
    Ok(())
}

fn skip_hevc_sps(bits: &mut Bits) -> Result<()> {
    bits.skip(4)?;
    let layers = bits.read(3)? as usize;
    if layers > 6 {
        return Err(INVALID);
    }
    bits.skip(1 + 96)?; // temporal nesting and general profile_tier_level
    let mut sublayers = Vec::new();
    for _ in 0..layers {
        sublayers.push((bits.flag()?, bits.flag()?));
    }
    if layers > 0 {
        bits.skip(2 * (8 - layers))?;
    }
    for (profile, level) in sublayers {
        if profile {
            bits.skip(88)?;
        }
        if level {
            bits.skip(8)?;
        }
    }
    bits.ue(15)?;
    if bits.ue(3)? == 3 {
        bits.skip(1)?;
    }
    bits.ues(2)?;
    if bits.flag()? {
        bits.ues(4)?;
    }
    bits.ues(2)?;
    let poc_bits = bits.ue(12)? as usize + 4;
    let first = if bits.flag()? { 0 } else { layers };
    for _ in first..=layers {
        bits.ues(3)?;
    }
    bits.ues(6)?;
    if bits.flag()? && bits.flag()? {
        for size in 0..4 {
            for _matrix in (0..6).step_by(if size == 3 { 3 } else { 1 }) {
                if bits.flag()? {
                    if size > 1 {
                        bits.ues(1)?;
                    }
                    bits.ues((1_usize << (4 + 2 * size)).min(64))?;
                } else {
                    bits.ues(1)?;
                }
            }
        }
    }
    bits.skip(2)?;
    if bits.flag()? {
        bits.skip(8)?;
        bits.ues(2)?;
        bits.skip(1)?;
    }
    let sets = bits.ue(64)?;
    let mut previous = 0;
    for index in 0..sets {
        if index > 0 && bits.flag()? {
            bits.skip(1)?;
            bits.ues(1)?;
            let mut count = 0;
            for _ in 0..=previous {
                let used = bits.flag()?;
                if used || bits.flag()? {
                    count += 1;
                }
            }
            previous = count;
        } else {
            let count = bits.ue(16)? + bits.ue(16)?;
            if count > 16 {
                return Err(INVALID);
            }
            for _ in 0..count {
                bits.ues(1)?;
                bits.skip(1)?;
            }
            previous = count;
        }
    }
    if bits.flag()? {
        let count = bits.ue(32)?;
        bits.skip(count as usize * (poc_bits + 1))?;
    }
    bits.skip(2)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{
        color::{ColorMatrix, ColorRange},
        MediaOptions,
    };

    // SPS from synthetic 256x64 grayscale encoded by the Windows MF driver.
    const H264: &str = "6742c02995a0409b016a02000a800001f400007530078e1550";
    const HEVC: &str = "420101216000000300900000030000030078a0080810596b4a421192e30142021a0a08000003000800000300f040";

    fn fixture(hevc: bool) -> Vec<u8> {
        let hex = if hevc { HEVC } else { H264 };
        (0..hex.len())
            .step_by(2)
            .map(|n| u8::from_str_radix(&hex[n..n + 2], 16).unwrap())
            .collect()
    }

    fn video_signal(bits: &mut Bits, hevc: bool) -> usize {
        if hevc {
            skip_hevc_sps(bits).unwrap();
        } else {
            skip_h264_sps(bits).unwrap();
        }
        assert!(bits.flag().unwrap());
        if bits.flag().unwrap() && bits.read(8).unwrap() == 255 {
            bits.skip(32).unwrap();
        }
        if bits.flag().unwrap() {
            bits.skip(1).unwrap();
        }
        bits.at
    }

    #[test]
    fn corrects_driver_tags_preserving_timing_and_other_nals() {
        for hevc in [false, true] {
            for color_matrix in [ColorMatrix::Bt601, ColorMatrix::Bt709] {
                for color_range in [ColorRange::Limited, ColorRange::Full] {
                    let color = MediaOptions {
                        color_matrix,
                        color_range,
                        ..Default::default()
                    }
                    .color_space();
                    let nal = fixture(hevc);
                    let header = if hevc { 2 } else { 1 };
                    let codec = if hevc {
                        EncodedVideoCodec::H265
                    } else {
                        EncodedVideoCodec::H264
                    };
                    let prefix = [0, 0, 1, if hevc { 70 } else { 9 }, 0x80];
                    let suffix = [0, 0, 0, 1, if hevc { 2 } else { 1 }, 0x91];
                    let mut packet = [prefix.as_slice(), &[0, 0, 0, 1], &nal, &suffix].concat();
                    normalize(&mut packet, codec, color).unwrap();
                    assert!(packet.starts_with(&prefix));
                    assert!(packet.ends_with(&suffix));
                    let mut before = unpack(&nal[header..]).unwrap();
                    let start = video_signal(&mut before, hevc);
                    let mut after =
                        unpack(&packet[prefix.len() + 4 + header..packet.len() - suffix.len()])
                            .unwrap();
                    assert_eq!(video_signal(&mut after, hevc), start);
                    assert_eq!(&before.data[..start], &after.data[..start]);
                    assert_eq!(&before.data[start + 30..], &after.data[start + 30..]);
                    assert_eq!(after.read(4).unwrap(), 13); // signal present, unspecified video format
                    assert_eq!(after.flag().unwrap(), color_range == ColorRange::Full);
                    assert!(after.flag().unwrap());
                    assert_eq!(after.read(8).unwrap(), 1);
                    assert_eq!(after.read(8).unwrap(), 13);
                    assert_eq!(
                        after.read(8).unwrap(),
                        if color_matrix == ColorMatrix::Bt709 {
                            1
                        } else {
                            6
                        }
                    );
                    let once = packet.clone();
                    normalize(&mut packet, codec, color).unwrap();
                    assert_eq!(packet, once);
                }
            }
        }
    }

    #[test]
    fn adds_absent_vui_without_changing_sps_extension_or_trailing_bits() {
        for hevc in [false, true] {
            let nal = fixture(hevc);
            let mut bits = unpack(&nal[if hevc { 2 } else { 1 }..]).unwrap();
            if hevc {
                skip_hevc_sps(&mut bits).unwrap();
            } else {
                skip_h264_sps(&mut bits).unwrap();
            }
            let prefix = bits.data[..bits.at].to_vec();
            bits.data.truncate(bits.at);
            bits.data.push(0); // VUI absent
            if hevc {
                bits.data.push(0);
            } // SPS extensions absent
            bits.data.push(1); // RBSP stop bit
            let color = MediaOptions::default().color_space();
            let result = rewrite_sps(&pack(bits.data), hevc, color).unwrap();
            let mut after = unpack(&result).unwrap();
            assert!(after.data.starts_with(&prefix));
            video_signal(&mut after, hevc);
            after.skip(30 + if hevc { 7 } else { 6 }).unwrap();
            assert_eq!(
                &after.data[after.at..],
                if hevc { &[0, 1][..] } else { &[1][..] }
            );
        }
    }

    #[test]
    fn malformed_and_truncated_sps_are_bounded_and_delta_frames_stay_identical() {
        let color = MediaOptions::default().color_space();
        for hevc in [false, true] {
            let nal = fixture(hevc);
            let rbsp = &nal[if hevc { 2 } else { 1 }..];
            for length in 0..rbsp.len() {
                let _ = rewrite_sps(&rbsp[..length], hevc, color);
            }
            assert!(rewrite_sps(&[0; 4097], hevc, color).is_err());
            assert!(rewrite_sps(&[], hevc, color).is_err());
            for position in 0..rbsp.len() {
                let mut corrupt = rbsp.to_vec();
                corrupt[position] ^= 0xff;
                let _ = rewrite_sps(&corrupt, hevc, color);
            }
        }
        let mut delta = vec![0, 0, 0, 1, 1, 0x80, 0, 0, 3, 1];
        let before = delta.clone();
        normalize(&mut delta, EncodedVideoCodec::H264, color).unwrap();
        assert_eq!(delta, before);
    }
}
