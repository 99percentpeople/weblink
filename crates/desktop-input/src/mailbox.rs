//! A bounded reliable lane and one coalesced move, ordered by local enqueue time.
use crate::input::Error;
use std::{collections::VecDeque, sync::Mutex};
const CAPACITY: usize = 128;
struct State<T> {
    reliable: VecDeque<(u64, T)>,
    movement: Option<(u64, T)>,
    ticket: u64,
    failure: Option<Error>,
}
pub(crate) struct Mailbox<T>(Mutex<State<T>>);
impl<T> Default for Mailbox<T> {
    fn default() -> Self {
        Self(Mutex::new(State {
            reliable: VecDeque::new(),
            movement: None,
            ticket: 0,
            failure: None,
        }))
    }
}
impl<T> Mailbox<T> {
    /// Local revoke discards pending work and runs before any subsequently submitted input.
    pub fn priority(&self, value: T) -> Result<(), Error> {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(error) = s.failure {
            return Err(error);
        }
        s.reliable.clear();
        s.movement = None;
        s.reliable.push_back((0, value));
        Ok(())
    }
    pub fn push(&self, value: T, movement: bool) -> Result<(), Error> {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = s.failure {
            return Err(e);
        }
        if !movement && s.reliable.len() >= CAPACITY {
            s.failure = Some(Error::QueueFull);
            s.reliable.clear();
            s.movement = None;
            return Err(Error::QueueFull);
        }
        s.ticket = s.ticket.checked_add(1).ok_or(Error::Closed)?;
        let ticket = s.ticket;
        if movement {
            s.movement = Some((ticket, value));
        } else {
            s.reliable.push_back((ticket, value));
        }
        Ok(())
    }
    pub fn pop(&self) -> Option<T> {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if s.failure.is_some() {
            return None;
        }
        let movement_first = s
            .movement
            .as_ref()
            .is_some_and(|(ticket, _)| s.reliable.front().is_none_or(|(front, _)| ticket < front));
        if movement_first {
            s.movement.take().map(|(_, v)| v)
        } else {
            s.reliable.pop_front().map(|(_, v)| v)
        }
    }
    pub fn clear(&self) {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.reliable.clear();
        s.movement = None;
    }
    pub fn close(&self, error: Error) {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.failure.get_or_insert(error);
        s.reliable.clear();
        s.movement = None;
    }
    pub fn failure(&self) -> Option<Error> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).failure
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn latest_move_is_bounded_and_respects_buttons() {
        let q = Mailbox::default();
        for i in 0..10000 {
            q.push(i, true).unwrap();
        }
        q.push(10000, false).unwrap();
        assert_eq!(q.pop(), Some(9999));
        assert_eq!(q.pop(), Some(10000));
        q.push(1, true).unwrap();
        q.push(2, false).unwrap();
        q.push(3, true).unwrap();
        assert_eq!(q.pop(), Some(2));
        assert_eq!(q.pop(), Some(3));
        assert_eq!(q.pop(), None);
        q.push(5, false).unwrap();
        q.push(6, true).unwrap();
        q.priority(7).unwrap();
        q.push(8, true).unwrap();
        assert_eq!(q.pop(), Some(7));
        assert_eq!(q.pop(), Some(8));
        assert_eq!(q.pop(), None);
        q.push(4, false).unwrap();
        q.clear();
        assert_eq!(q.pop(), None);
    }
    #[test]
    fn overflow_and_close_discard_everything_and_cannot_reopen() {
        let q = Mailbox::default();
        for i in 0..CAPACITY {
            q.push(i, false).unwrap();
        }
        q.push(0, true).unwrap();
        assert_eq!(q.push(0, false), Err(Error::QueueFull));
        assert_eq!(q.pop(), None);
        q.clear();
        q.close(Error::Closed);
        assert_eq!(q.failure(), Some(Error::QueueFull));
        assert_eq!(q.push(1, true), Err(Error::QueueFull));
    }
}
