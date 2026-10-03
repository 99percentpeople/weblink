//! Complete touch frames with per-grant contact ownership, independent of OS injection.
use crate::input::{Error, Geometry, Position, Rect};
use serde::Deserialize;
use std::collections::HashSet;
pub const MAX_CONTACTS: usize = 10;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Down,
    Update,
    Up,
    Cancel,
}
#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
pub struct Contact {
    pub id: u8,
    pub x: f64,
    pub y: f64,
    pub phase: Phase,
    /// Browser pressure in [0, 1]; absent means use the native default.
    pub pressure: Option<f64>,
    /// Contact dimensions relative to the displayed video content, not CSS pixels.
    pub width: Option<f64>,
    pub height: Option<f64>,
}
impl Contact {
    pub fn valid(self) -> bool {
        (1..=MAX_CONTACTS as u8).contains(&self.id)
            && self.x.is_finite()
            && self.y.is_finite()
            && (0.0..=1.0).contains(&self.x)
            && (0.0..=1.0).contains(&self.y)
            && self
                .pressure
                .is_none_or(|p| p.is_finite() && (0.0..=1.0).contains(&p))
            && match (self.width, self.height) {
                (None, None) => true,
                (Some(w), Some(h)) => {
                    w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 && w <= 1.0 && h <= 1.0
                }
                _ => false,
            }
    }
    fn area(self, display: Rect, x: i32, y: i32) -> Option<Rect> {
        let axis = |fraction: f64, origin: i32, span: u32, position: i32| {
            let length = (fraction * f64::from(span)).round().max(1.0) as i64;
            let start = i64::from(position) - length / 2;
            let end = (start + length).min(i64::from(origin) + i64::from(span));
            let start = start.max(i64::from(origin));
            (start as i32, (end - start) as u32)
        };
        let (left, width) = axis(self.width?, display.left, display.width, x);
        let (top, height) = axis(self.height?, display.top, display.height, y);
        Some(Rect {
            left,
            top,
            width,
            height,
        })
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Action {
    pub id: u8,
    pub x: i32,
    pub y: i32,
    pub phase: Phase,
    pub pressure: Option<u32>,
    pub contact: Option<Rect>,
}
pub fn valid_frame(contacts: &[Contact]) -> bool {
    !contacts.is_empty()
        && contacts.len() <= MAX_CONTACTS
        && contacts.iter().all(|c| c.valid())
        && (!contacts.iter().any(|c| c.phase == Phase::Cancel)
            || contacts.iter().all(|c| c.phase == Phase::Cancel))
        && contacts.iter().map(|c| c.id).collect::<HashSet<_>>().len() == contacts.len()
}
#[derive(Default)]
pub struct Contacts(HashSet<u8>);
impl Contacts {
    pub fn clear(&mut self) {
        self.0.clear();
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn frame(
        &mut self,
        contacts: &[Contact],
        geometry: Geometry,
    ) -> Result<Vec<Action>, Error> {
        if !valid_frame(contacts)
            || self
                .0
                .iter()
                .any(|id| !contacts.iter().any(|c| c.id == *id))
        {
            return Err(Error::Invalid);
        }
        let mut next = HashSet::new();
        let mut actions = Vec::with_capacity(contacts.len());
        for c in contacts {
            if self.0.contains(&c.id) == (c.phase == Phase::Down) {
                return Err(Error::Invalid);
            }
            let (x, y) = geometry
                .pixels(Position { x: c.x, y: c.y })
                .ok_or(Error::Invalid)?;
            actions.push(Action {
                id: c.id,
                x,
                y,
                phase: c.phase,
                pressure: c.pressure.map(|p| (p * 1024.0).round() as u32),
                contact: c.area(geometry.display, x, y),
            });
            if matches!(c.phase, Phase::Down | Phase::Update) {
                next.insert(c.id);
            }
        }
        self.0 = next;
        Ok(actions)
    }
}
