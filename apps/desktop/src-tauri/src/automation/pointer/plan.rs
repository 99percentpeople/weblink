//! Bounded, fully validated mouse gestures. No OS calls or authority mutations here.
use super::super::input_runner::Plan;
use serde_json::Value;
use weblink_desktop_input::input::{Button, Event, Geometry, Position};

impl Plan {
    pub fn pointer(args: &Value, geometry: Geometry, held: &[Button]) -> Result<Self, String> {
        super::super::catalog::validate("control.pointer", args)?;
        let read = |v: &Value| -> Result<Position, String> {
            let p = Position {
                x: v["x"].as_f64().ok_or("INVALID_ARGUMENTS")?,
                y: v["y"].as_f64().ok_or("INVALID_ARGUMENTS")?,
            };
            geometry.normalized(p).ok_or_else(|| "OUT_OF_BOUNDS".into())
        };
        let start = read(args)?;
        // Validate every waypoint before any button is pressed.
        let mut points = vec![start];
        if let Some(path) = args["path"].as_array() {
            for point in path {
                points.push(read(point)?);
            }
        }
        let button = match args["button"].as_str().unwrap_or("left") {
            "left" => Button::Left,
            "right" => Button::Right,
            "middle" => Button::Middle,
            "back" => Button::Back,
            "forward" => Button::Forward,
            _ => return Err("INVALID_ARGUMENTS".into()),
        };
        let action = args["action"].as_str().ok_or("INVALID_ARGUMENTS")?;
        if matches!(action, "click" | "drag") && !held.is_empty() {
            return Err("BUTTON_HELD".into());
        }
        if action == "down" && held.contains(&button) {
            return Err("BUTTON_ALREADY_DOWN".into());
        }
        if action == "up" && !held.contains(&button) {
            return Err("BUTTON_NOT_DOWN".into());
        }
        let mut plan = Self::default();
        let press = |position, down| Event::Button {
            position,
            button,
            down,
        };
        match action {
            "down" | "up" => plan.push(0., vec![press(start, action == "down")]),
            "click" => {
                let count = args["clickCount"].as_u64().unwrap_or(1);
                let hold = args["holdMs"].as_u64().unwrap_or(30) as f64;
                let interval = args["intervalMs"].as_u64().unwrap_or(100) as f64;
                for i in 0..count {
                    let at = i as f64 * (hold + interval);
                    plan.push(at, vec![press(start, true)]);
                    plan.push(at + hold, vec![press(start, false)]);
                }
            }
            "scroll" => plan.push(
                0.,
                vec![Event::Wheel {
                    position: start,
                    horizontal: args["scrollX"].as_i64().unwrap() as i32,
                    vertical: args["scrollY"].as_i64().unwrap() as i32,
                }],
            ),
            "move" | "drag" => {
                plan.push(
                    0.,
                    vec![if action == "drag" {
                        press(start, true)
                    } else {
                        Event::Move(start)
                    }],
                );
                if points.len() > 1 {
                    let duration = args["durationMs"].as_u64().unwrap_or(500) as f64;
                    // Each segment receives an equal time slice, with <=16 ms interpolation steps.
                    let segment_ms = duration / (points.len() - 1) as f64;
                    let count = (segment_ms / 16.).ceil().max(1.) as usize;
                    for (segment, pair) in points.windows(2).enumerate() {
                        for i in 1..=count {
                            let t = i as f64 / count as f64;
                            let point = Position {
                                x: pair[0].x + (pair[1].x - pair[0].x) * t,
                                y: pair[0].y + (pair[1].y - pair[0].y) * t,
                            };
                            plan.push(segment_ms * (segment as f64 + t), vec![Event::Move(point)]);
                        }
                    }
                    if action == "drag" {
                        plan.push(duration, vec![press(*points.last().unwrap(), false)]);
                    }
                }
            }
            _ => return Err("INVALID_ARGUMENTS".into()),
        }
        Ok(plan)
    }
}
