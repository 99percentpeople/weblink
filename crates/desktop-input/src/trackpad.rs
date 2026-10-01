//! Relative gestures resolved against the current physical cursor on the input thread.
use crate::input::{self, Button, Error, Geometry, Position};
use serde::Deserialize;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Pan {
        #[serde(flatten)]
        gesture: crate::pan::Pan,
    },
    Move {
        x: f64,
        y: f64,
    },
    Button {
        button: u8,
        down: bool,
    },
    Wheel {
        horizontal: i32,
        vertical: i32,
    },
}
impl Event {
    pub fn valid(self) -> bool {
        match self {
            Self::Pan { gesture } => gesture.valid(),
            Self::Move { x, y } => {
                x.is_finite()
                    && y.is_finite()
                    && (-1.0..=1.0).contains(&x)
                    && (-1.0..=1.0).contains(&y)
            }
            Self::Button { button, .. } => button <= 4,
            Self::Wheel {
                horizontal,
                vertical,
            } => (-1200..=1200).contains(&horizontal) && (-1200..=1200).contains(&vertical),
        }
    }
}

#[derive(Default)]
pub struct Cursor {
    expected: Option<(i32, i32)>,
    remainder: (f64, f64),
}
impl Cursor {
    pub fn resolve(
        &mut self,
        event: Event,
        current: (i32, i32),
        geometry: Geometry,
    ) -> Result<input::Event, Error> {
        if !event.valid() || !geometry.valid() {
            return Err(Error::Invalid);
        }
        if self.expected != Some(current) {
            self.remainder = (0.0, 0.0);
        }
        let display = geometry.display;
        let position = |x: f64, y: f64| Position {
            x: ((x - f64::from(display.left)) / f64::from((display.width - 1).max(1)))
                .clamp(0.0, 1.0),
            y: ((y - f64::from(display.top)) / f64::from((display.height - 1).max(1)))
                .clamp(0.0, 1.0),
        };
        let current_position = position(f64::from(current.0), f64::from(current.1));
        let resolved = match event {
            Event::Pan { .. } => return Err(Error::Invalid),
            Event::Move { x, y } => {
                let origin = geometry.pixels(current_position).ok_or(Error::Invalid)?;
                let target_x =
                    f64::from(origin.0) + x * f64::from(display.width - 1) + self.remainder.0;
                let target_y =
                    f64::from(origin.1) + y * f64::from(display.height - 1) + self.remainder.1;
                let next = position(target_x, target_y);
                let pixel = geometry.pixels(next).ok_or(Error::Invalid)?;
                self.expected = Some(pixel);
                self.remainder = (
                    if next.x > 0.0 && next.x < 1.0 {
                        target_x - f64::from(pixel.0)
                    } else {
                        0.0
                    },
                    if next.y > 0.0 && next.y < 1.0 {
                        target_y - f64::from(pixel.1)
                    } else {
                        0.0
                    },
                );
                input::Event::Move(next)
            }
            Event::Button { button, down } => input::Event::Button {
                position: current_position,
                button: match button {
                    0 => Button::Left,
                    1 => Button::Middle,
                    2 => Button::Right,
                    3 => Button::Back,
                    _ => Button::Forward,
                },
                down,
            },
            Event::Wheel {
                horizontal,
                vertical,
            } => input::Event::Wheel {
                position: current_position,
                horizontal,
                vertical,
            },
        };
        Ok(resolved)
    }
}
