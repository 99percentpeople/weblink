use super::{Bounds, Service};
use std::time::{Duration, Instant};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const DURATION: Duration = Duration::from_millis(280);

#[derive(Clone, Copy)]
pub(super) enum Finish {
    Enter,
    Restore { focus: bool },
}

pub(super) struct Transition {
    pub id: u64,
    pub from: Bounds,
    pub to: Bounds,
    pub finish: Finish,
    started: Instant,
}

impl Transition {
    pub fn new(id: u64, from: Bounds, to: Bounds, finish: Finish) -> Self {
        Self {
            id,
            from,
            to,
            finish,
            started: Instant::now(),
        }
    }
    pub fn frame(&self) -> (Bounds, bool) {
        let progress = (self.started.elapsed().as_secs_f64() / DURATION.as_secs_f64()).min(1.0);
        (interpolate(self.from, self.to, progress), progress >= 1.0)
    }
}

fn interpolate(from: Bounds, to: Bounds, progress: f64) -> Bounds {
    let eased = ease_out(progress);
    let lerp = |a: f64, b: f64| (a + (b - a) * eased).round();
    Bounds {
        position: PhysicalPosition::new(
            lerp(from.position.x as f64, to.position.x as f64) as i32,
            lerp(from.position.y as f64, to.position.y as f64) as i32,
        ),
        size: PhysicalSize::new(
            lerp(from.size.width as f64, to.size.width as f64).max(1.0) as u32,
            lerp(from.size.height as f64, to.size.height as f64).max(1.0) as u32,
        ),
    }
}

fn ease_out(progress: f64) -> f64 {
    let x = progress.clamp(0.0, 1.0);
    if x == 0.0 || x == 1.0 {
        return x;
    }
    // Match the layout and toolbar's cubic-bezier(0.22, 1, 0.36, 1).
    let (mut low, mut high) = (0.0, 1.0);
    for _ in 0..18 {
        let t = (low + high) / 2.0;
        let inverse = 1.0 - t;
        let curve_x = 3.0 * inverse * inverse * t * 0.22 + 3.0 * inverse * t * t * 0.36 + t * t * t;
        if curve_x < x {
            low = t;
        } else {
            high = t;
        }
    }
    1.0 - (1.0_f64 - (low + high) / 2.0).powi(3)
}

#[cfg(windows)]
fn apply_outer(hwnd: windows::Win32::Foundation::HWND, bounds: Bounds) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };
    // Bounds already includes non-client decorations. Adding a frame here would
    // enlarge every restore and then contaminate the next normal-window snapshot.
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            bounds.position.x,
            bounds.position.y,
            bounds.size.width.min(i32::MAX as u32) as i32,
            bounds.size.height.min(i32::MAX as u32) as i32,
            SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER,
        )
    }
    .map_err(|e| e.to_string())
}

pub(super) fn apply(window: &WebviewWindow, bounds: Bounds) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        apply_outer(HWND(window.hwnd().map_err(|e| e.to_string())?.0), bounds)
    }
    #[cfg(not(windows))]
    {
        let frame = super::FrameInsets::read(window).map_err(|e| e.to_string())?;
        window
            .set_size(frame.client_size(bounds.size))
            .map_err(|e| e.to_string())?;
        window
            .set_position(bounds.position)
            .map_err(|e| e.to_string())
    }
}

pub(super) fn drive(window: WebviewWindow, id: u64) {
    // Only one frame may be queued. Delayed frames use elapsed time, so a busy
    // renderer/event loop does not accumulate resize work or extend the motion.
    std::thread::spawn(move || loop {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let next = window.clone();
        if window
            .run_on_main_thread(move || {
                let service = next.state::<Service>();
                let running = service
                    .0
                    .try_lock()
                    .map(|mut state| state.advance(&next, id))
                    .unwrap_or(true);
                let _ = send.send(running);
            })
            .is_err()
        {
            window.state::<Service>().shutdown();
            break;
        }
        if receive.recv() != Ok(true) {
            break;
        }
        std::thread::sleep(Duration::from_millis(16));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resize_round_trip_retains_bounds_across_negative_monitor_origins() {
        let normal = Bounds {
            position: (-1600, -200).into(),
            size: (1280, 800).into(),
        };
        let compact = Bounds {
            position: (-496, 600).into(),
            size: (480, 386).into(),
        };
        assert_eq!(interpolate(normal, compact, 0.0), normal);
        assert_eq!(interpolate(normal, compact, 1.0), compact);
        assert_eq!(interpolate(compact, normal, 1.0), normal);
        let interrupted = interpolate(normal, compact, 0.4);
        assert_eq!(interpolate(interrupted, normal, 0.0), interrupted);
        assert_eq!(interpolate(interrupted, normal, 2.0), normal);
    }
    #[test]
    fn easing_decelerates_without_overshooting_or_reversing() {
        assert_eq!(ease_out(0.0), 0.0);
        assert_eq!(ease_out(1.0), 1.0);
        assert!(ease_out(0.5) > 0.8);
        let values: Vec<_> = (0..=100).map(|i| ease_out(i as f64 / 100.0)).collect();
        assert!(values.windows(2).all(|v| v[0] <= v[1] && v[1] <= 1.0));
    }
}

#[cfg(all(test, windows))]
mod windows_tests;
