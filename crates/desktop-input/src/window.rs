//! Native-only input confinement. Window identifiers never enter the wire protocol.
use crate::input::Error;
use std::sync::Arc;

pub type BoundWindow = Arc<dyn WindowGuard>;
pub trait WindowGuard: Send + Sync {
    /// Validate identity, foreground ownership and an optional physical desktop point.
    /// Must be fast, nonblocking and independent of application/transport locks.
    fn check(&self, point: Option<(i32, i32)>) -> Result<(), Error>;
    /// Explicit activation at binding time only; never steal focus during input.
    fn activate(&self) -> Result<(), Error>;
}
