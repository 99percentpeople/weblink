//! One render worker and DirectComposition target per window, with latest-frame admission.
use super::{Frame, Source, Subscription};
use serde::Deserialize;
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows_core::Interface;
#[derive(Clone, Copy, Default, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Layout {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub radius: f32,
    pub visible: bool,
}
impl Layout {
    pub fn validate(&self) -> Result<(), String> {
        if [self.x, self.y, self.width, self.height, self.radius]
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 32768.)
            || self.width < 0.
            || self.height < 0.
            || self.radius < 0.
        {
            return Err("Invalid native video bounds".into());
        }
        Ok(())
    }
}
struct Binding {
    source: Arc<Source>,
    layout: Layout,
    _watch: Subscription,
}
#[derive(Default)]
struct State {
    bindings: HashMap<u64, Binding>,
    closed: bool,
}
pub struct Compositor {
    state: Arc<Mutex<State>>,
    wake: mpsc::SyncSender<()>,
    worker: Option<JoinHandle<()>>,
}
unsafe extern "C" {
    fn wl_composition_create(hwnd: *mut c_void, out: *mut *mut c_void) -> i32;
    fn wl_composition_destroy(c: *mut c_void);
    fn wl_composition_layout(
        c: *mut c_void,
        id: u64,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        radius: f32,
        visible: i32,
    ) -> i32;
    fn wl_composition_submit(
        c: *mut c_void,
        id: u64,
        texture: *mut c_void,
        subresource: u32,
        crop_x: u32,
        crop_y: u32,
        width: u32,
        height: u32,
        bt709: i32,
        full_range: i32,
    ) -> i32;
    fn wl_composition_poll(c: *mut c_void, id: u64) -> i32;
    fn wl_composition_remove(c: *mut c_void, id: u64) -> i32;
    fn wl_composition_commit(c: *mut c_void) -> i32;
}
struct Native(*mut c_void);
impl Drop for Native {
    fn drop(&mut self) {
        unsafe { wl_composition_destroy(self.0) }
    }
}
struct View {
    submitted: u64,
    lease: Option<Arc<Frame>>,
    layout: Option<Layout>,
}
impl Compositor {
    /// HWND must remain valid until this compositor is dropped.
    pub fn new(hwnd: usize) -> Result<Self, String> {
        let state = Arc::new(Mutex::new(State::default()));
        let (wake, receive) = mpsc::sync_channel(1);
        let (ready, initialized) = mpsc::sync_channel(1);
        let shared = state.clone();
        let worker = thread::Builder::new()
            .name("native-composition".into())
            .spawn(move || unsafe {
                use windows::Win32::System::Com::{
                    CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED,
                };
                let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
                let mut ptr = std::ptr::null_mut();
                let hr = wl_composition_create(hwnd as *mut c_void, &mut ptr);
                let _ = ready.send(if hr < 0 {
                    Err(format!("DirectComposition initialization failed: {hr:#x}"))
                } else {
                    Ok(())
                });
                if hr >= 0 {
                    let native = Native(ptr);
                    run(&native, &shared, receive);
                    drop(native);
                }
                if com {
                    CoUninitialize();
                }
            })
            .map_err(|e| e.to_string())?;
        if let Err(error) = initialized.recv().map_err(|e| e.to_string())? {
            let _ = worker.join();
            return Err(error);
        }
        Ok(Self {
            state,
            wake,
            worker: Some(worker),
        })
    }
    pub fn bind(&self, id: u64, source: Arc<Source>, layout: Layout) -> Result<(), String> {
        layout.validate()?;
        let mut state = self.state.lock().unwrap();
        if let Some(binding) = state.bindings.get_mut(&id) {
            if !Arc::ptr_eq(&binding.source, &source) {
                return Err("Native view source changed".into());
            }
            binding.layout = layout;
        } else {
            if state.bindings.len() >= 16 {
                return Err("Native video view limit reached".into());
            }
            let wake = self.wake.clone();
            let watch = source.observe(
                Arc::new(move || {
                    let _ = wake.try_send(());
                }),
                false,
            );
            state.bindings.insert(
                id,
                Binding {
                    source,
                    layout,
                    _watch: watch,
                },
            );
        }
        let _ = self.wake.try_send(());
        Ok(())
    }
    pub fn remove(&self, id: u64) {
        self.state.lock().unwrap().bindings.remove(&id);
        let _ = self.wake.try_send(());
    }
}
impl Drop for Compositor {
    fn drop(&mut self) {
        {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.bindings.clear();
        }
        let _ = self.wake.try_send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn run(native: &Native, shared: &Mutex<State>, wake: mpsc::Receiver<()>) {
    let mut views: HashMap<u64, View> = HashMap::new();
    loop {
        let (closed, bindings) = {
            let state = shared.lock().unwrap();
            (
                state.closed,
                state
                    .bindings
                    .iter()
                    .map(|(&id, b)| (id, (b.source.clone(), b.layout)))
                    .collect::<HashMap<_, _>>(),
            )
        };
        let mut pending = false;
        for &id in bindings.keys() {
            views.entry(id).or_insert_with(|| View {
                submitted: 0,
                lease: None,
                layout: None,
            });
        }
        views.retain(|&id, view| unsafe {
            if view.lease.is_some() {
                if wl_composition_poll(native.0, id) == 1 {
                    pending = true;
                } else {
                    view.lease = None;
                }
            }
            let binding = bindings.get(&id).filter(|(source, _)| !source.closed());
            let Some((source, layout)) = binding else {
                // Hide immediately, but keep the sample until the GPU finishes.
                let _ = wl_composition_layout(native.0, id, 0., 0., 0., 0., 0., 0);
                if view.lease.is_some() {
                    return true;
                }
                let _ = wl_composition_remove(native.0, id);
                return false;
            };
            if view.layout != Some(*layout) {
                let hr = wl_composition_layout(
                    native.0,
                    id,
                    layout.x,
                    layout.y,
                    layout.width,
                    layout.height,
                    layout.radius,
                    layout.visible as i32,
                );
                if hr < 0 {
                    source.fail(format!("Native video layout: {hr:#x}"));
                }
                view.layout = Some(*layout);
            }
            if !layout.visible || view.lease.is_some() {
                return true;
            }
            let Some(frame) = source.latest().filter(|f| f.sequence != view.submitted) else {
                return true;
            };
            let t = &frame.texture;
            let queue_ms = frame.ready.elapsed().as_secs_f64() * 1000.;
            let start = Instant::now();
            let hr = wl_composition_submit(
                native.0,
                id,
                t.texture.as_raw(),
                t.subresource,
                t.crop.0,
                t.crop.1,
                t.size.0,
                t.size.1,
                t.bt709 as i32,
                t.full_range as i32,
            );
            if hr == 1 {
                pending = true;
                return true;
            }
            view.submitted = frame.sequence;
            if hr < 0 {
                source.fail(format!("Native video presentation: {hr:#x}"));
            } else {
                source.presented(queue_ms, start.elapsed().as_secs_f64() * 1000.);
            }
            view.lease = Some(frame);
            pending = true;
            true
        });
        // Layout, removal and swap-chain changes share one composition commit.
        // Bindings already hold only the latest layout, so animations cannot
        // accumulate a FIFO of obsolete positions behind frame presentation.
        let hr = unsafe { wl_composition_commit(native.0) };
        if hr < 0 {
            for (source, _) in bindings.values() {
                source.fail(format!("Native video composition: {hr:#x}"));
            }
        }
        if closed && views.is_empty() {
            break;
        }
        if pending {
            let _ = wake.recv_timeout(Duration::from_millis(2));
        } else if wake.recv().is_err() {
            break;
        }
    }
}
