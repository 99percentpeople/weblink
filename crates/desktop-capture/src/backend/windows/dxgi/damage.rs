//! Metadata failure only disables the hint; the acquired texture remains complete.
use crate::damage::{Damage, DirtyRect};
use windows::Win32::{
    Foundation::RECT,
    Graphics::Dxgi::{IDXGIOutputDuplication, DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_MOVE_RECT},
};

pub(super) fn read(
    output: &IDXGIOutputDuplication,
    info: &DXGI_OUTDUPL_FRAME_INFO,
    size: (u32, u32),
) -> Damage {
    read_rects(output, info).map_or_else(Damage::default, |rects| {
        Damage::from_rects(Some(&rects), size)
    })
}

fn read_rects(
    output: &IDXGIOutputDuplication,
    info: &DXGI_OUTDUPL_FRAME_INFO,
) -> Option<Vec<DirtyRect>> {
    if info.LastPresentTime == 0 {
        // Pointer-only acquisition; the separate cursor is handled downstream.
        return Some(Vec::new());
    }
    let bytes = info.TotalMetadataBufferSize as usize;
    if bytes == 0 || bytes > crate::damage::MAX_DIRTY_RECTS * size_of::<DXGI_OUTDUPL_MOVE_RECT>() {
        return None;
    }
    let mut dirty = vec![RECT::default(); bytes.div_ceil(size_of::<RECT>())];
    let mut moves = vec![
        DXGI_OUTDUPL_MOVE_RECT::default();
        bytes.div_ceil(size_of::<DXGI_OUTDUPL_MOVE_RECT>())
    ];
    let mut required = 0;
    unsafe {
        output
            .GetFrameDirtyRects(bytes as u32, dirty.as_mut_ptr(), &mut required)
            .ok()?;
    }
    if required as usize > bytes || !(required as usize).is_multiple_of(size_of::<RECT>()) {
        return None;
    }
    dirty.truncate(required as usize / size_of::<RECT>());
    unsafe {
        output
            .GetFrameMoveRects(bytes as u32, moves.as_mut_ptr(), &mut required)
            .ok()?;
    }
    if required as usize > bytes
        || !(required as usize).is_multiple_of(size_of::<DXGI_OUTDUPL_MOVE_RECT>())
    {
        return None;
    }
    moves.truncate(required as usize / size_of::<DXGI_OUTDUPL_MOVE_RECT>());
    let mut rects: Vec<_> = dirty.into_iter().map(from_rect).collect();
    // We send complete textures, so moved regions can conservatively become
    // dirty bounds. No reference-frame-dependent move operation crosses a drop.
    for moved in moves {
        let destination = from_rect(moved.DestinationRect);
        let width = destination.right.checked_sub(destination.left)?;
        let height = destination.bottom.checked_sub(destination.top)?;
        rects.push(destination);
        rects.push(DirtyRect {
            left: moved.SourcePoint.x,
            top: moved.SourcePoint.y,
            right: moved.SourcePoint.x.checked_add(width)?,
            bottom: moved.SourcePoint.y.checked_add(height)?,
        });
    }
    // A reported desktop update with no usable metadata is not proof of no change.
    (!rects.is_empty()).then_some(rects)
}
fn from_rect(rect: RECT) -> DirtyRect {
    DirtyRect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}
