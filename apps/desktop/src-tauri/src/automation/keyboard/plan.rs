use super::super::{catalog, input_runner::Plan};
use serde_json::Value;
use weblink_desktop_input::input::{Event, ScanCode};

impl Plan {
    pub fn key(args: &Value, held: &[ScanCode]) -> Result<Self, String> {
        catalog::validate("control.key", args)?;
        let action = args["action"].as_str().ok_or("INVALID_ARGUMENTS")?;
        let names: Vec<&str> = if action == "chord" {
            args["keys"]
                .as_array()
                .ok_or("INVALID_ARGUMENTS")?
                .iter()
                .map(|v| v.as_str().ok_or("INVALID_ARGUMENTS"))
                .collect::<Result<_, _>>()?
        } else {
            vec![args["key"].as_str().ok_or("INVALID_ARGUMENTS")?]
        };
        // Resolve the entire chord and reject overlaps before emitting any event.
        let keys = names
            .into_iter()
            .map(super::key)
            .collect::<Result<Vec<_>, _>>()?;
        if action == "up" {
            if !held.contains(&keys[0]) {
                return Err("KEY_NOT_DOWN".into());
            }
        } else if keys.iter().any(|key| held.contains(key)) {
            return Err("KEY_ALREADY_DOWN".into());
        }
        let mut plan = Self {
            paced: true,
            ..Self::default()
        };
        if matches!(action, "down" | "up") {
            plan.push(
                0.,
                vec![Event::Key {
                    key: keys[0],
                    down: action == "down",
                }],
            );
            return Ok(plan);
        }
        let hold = args["holdMs"].as_u64().unwrap_or(30);
        let repeat = args["repeat"].as_u64().unwrap_or(1);
        let interval = args["intervalMs"].as_u64().unwrap_or(100);
        if repeat * hold + (repeat - 1) * interval > 10000 {
            return Err("DURATION_LIMIT".into());
        }
        for i in 0..repeat {
            // Separate steps allow cancellation even between chord members.
            for (member, key) in keys.iter().enumerate() {
                plan.push(
                    if i > 0 && member == 0 {
                        interval as f64
                    } else {
                        0.
                    },
                    vec![Event::Key {
                        key: *key,
                        down: true,
                    }],
                );
            }
            for (member, key) in keys.iter().rev().enumerate() {
                plan.push(
                    if member == 0 { hold as f64 } else { 0. },
                    vec![Event::Key {
                        key: *key,
                        down: false,
                    }],
                );
            }
        }
        Ok(plan)
    }
    pub fn text(args: &Value, held: bool) -> Result<Self, String> {
        catalog::validate("control.text", args)?;
        if held {
            return Err("INPUT_HELD".into());
        }
        let text = args["text"].as_str().ok_or("INVALID_ARGUMENTS")?;
        if text.chars().any(char::is_control) {
            return Err("CONTROL_CHARACTER".into());
        }
        let chars: Vec<_> = text.chars().collect();
        let interval = args["intervalMs"].as_u64().unwrap_or(0);
        if (chars.len() as u64 - 1) * interval > 10000 {
            return Err("DURATION_LIMIT".into());
        }
        let mut plan = Self {
            paced: true,
            ..Self::default()
        };
        // <=32 Unicode scalar values => <=64 UTF-16 units. Never split a surrogate pair.
        for (i, chunk) in chars.chunks(if interval == 0 { 32 } else { 1 }).enumerate() {
            plan.push(
                if i == 0 { 0. } else { interval as f64 },
                vec![Event::Text(chunk.iter().collect())],
            );
        }
        Ok(plan)
    }
}
