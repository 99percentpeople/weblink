//! Native input values, not a network deserialization surface.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}
impl Rect {
    pub fn valid(self) -> bool {
        self.width > 0
            && self.height > 0
            && i32::try_from(i64::from(self.left) + i64::from(self.width)).is_ok()
            && i32::try_from(i64::from(self.top) + i64::from(self.height)).is_ok()
    }
    pub fn contains(self, other: Self) -> bool {
        self.valid()
            && other.valid()
            && other.left >= self.left
            && other.top >= self.top
            && i64::from(other.left) + i64::from(other.width)
                <= i64::from(self.left) + i64::from(self.width)
            && i64::from(other.top) + i64::from(other.height)
                <= i64::from(self.top) + i64::from(self.height)
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub display: Rect,
    pub desktop: Rect,
}
impl Geometry {
    pub fn valid(self) -> bool {
        self.desktop.contains(self.display)
    }
    /// Convert physical desktop pixels to the display-local wire contract.
    /// Bounds are already oriented; OS DPI scaling must not be applied again.
    pub fn normalized(self, position: Position) -> Option<Position> {
        if !self.valid() {
            return None;
        }
        let axis = |value: f64, origin: i32, span: u32| {
            let pixel = value - f64::from(origin);
            if !pixel.is_finite() || pixel < 0.0 || pixel >= f64::from(span) {
                return None;
            }
            Some(if span == 1 {
                0.0
            } else {
                pixel.round().min(f64::from(span - 1)) / f64::from(span - 1)
            })
        };
        Some(Position {
            x: axis(position.x, self.display.left, self.display.width)?,
            y: axis(position.y, self.display.top, self.display.height)?,
        })
    }
    pub fn pixels(self, position: Position) -> Option<(i32, i32)> {
        if !self.valid()
            || !position.x.is_finite()
            || !position.y.is_finite()
            || !(0.0..=1.0).contains(&position.x)
            || !(0.0..=1.0).contains(&position.y)
        {
            return None;
        }
        Some((
            (i64::from(self.display.left)
                + (position.x * f64::from(self.display.width - 1)).round() as i64)
                as i32,
            (i64::from(self.display.top)
                + (position.y * f64::from(self.display.height - 1)).round() as i64)
                as i32,
        ))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}
/// Physical key identifier in the existing wire contract (PC set-1, not an OS keycode).
/// Backends translate this identifier to native key events. E1/Pause and PrintScreen are unsupported.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScanCode {
    code: u16,
    extended: bool,
}
impl ScanCode {
    pub fn new(code: u16, extended: bool) -> Option<Self> {
        let allowed = if extended {
            matches!(code, 0x1c | 0x1d | 0x35 | 0x38 | 0x47..=0x49 | 0x4b | 0x4d | 0x4f..=0x53 | 0x5b..=0x5d)
        } else {
            matches!(code, 0x01..=0x53 | 0x56..=0x58)
        };
        allowed.then_some(Self { code, extended })
    }
    pub fn code(self) -> u16 {
        self.code
    }
    pub fn extended(self) -> bool {
        self.extended
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Held {
    Key(ScanCode),
    Button(Button),
}
pub(crate) fn valid_text(text: &str) -> bool {
    // Preserve the existing wire size limit, independently of the backend's native encoding.
    !text.is_empty()
        && text.len() <= 256
        && text.encode_utf16().count() <= 64
        && !text.chars().any(char::is_control)
}
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Gamepad(crate::gamepad::Event),
    Trackpad(crate::trackpad::Event),
    Touch(Vec<crate::touch::Contact>),
    Move(Position),
    Button {
        position: Position,
        button: Button,
        down: bool,
    },
    /// Wire scroll units: 120 = one detent. Each axis is bounded to +/-1200.
    Wheel {
        position: Position,
        horizontal: i32,
        vertical: i32,
    },
    Key {
        key: ScanCode,
        down: bool,
    },
    /// Committed text, not a parallel copy of physical key events. At most 64 UTF-16 units.
    Text(String),
    /// Native caller cleanup only; never accepted from the remote wire protocol.
    ReleaseInputs(Vec<Held>),
    ReleaseAll,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Physical desktop pixels, including negative multi-monitor origins.
    Move {
        x: i32,
        y: i32,
    },
    Button {
        button: Button,
        down: bool,
    },
    Wheel {
        horizontal: bool,
        delta: i32,
    },
    Key {
        key: ScanCode,
        down: bool,
    },
}
impl Held {
    pub fn up(self) -> Action {
        match self {
            Self::Key(key) => Action::Key { key, down: false },
            Self::Button(button) => Action::Button {
                button,
                down: false,
            },
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    WindowUnavailable,
    WindowFocusLost,
    WindowPointOutside,
    Invalid,
    Unavailable,
    Unauthorized,
    Injection,
    Release,
    QueueFull,
    Stale,
    Closed,
    Timeout,
    Cancelled,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Native input: {self:?}")
    }
}
impl std::error::Error for Error {}
