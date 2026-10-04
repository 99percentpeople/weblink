use super::*;

impl crate::session::Session for Worker {
    fn set_waker(&self, owner: thread::Thread) -> bool {
        *self.observer.lock().unwrap_or_else(|e| e.into_inner()) = Some(owner.clone());
        owner.unpark();
        true
    }
    fn register_until(
        &self,
        target: TrustedTarget,
        invalidated: Arc<AtomicBool>,
    ) -> Result<bool, Error> {
        Worker::register_until(self, target, invalidated)
    }
    fn request(&self, media: String, signal: Signal) -> Result<Option<RequestResult>, Error> {
        Worker::request(self, media, signal)
    }
    fn approve(&self, consent: String) -> Result<Option<Signal>, Error> {
        Worker::approve(self, consent)
    }
    fn decline(&self, consent: String) -> Result<Option<Signal>, Error> {
        Worker::decline(self, consent)
    }
    fn renew(&self, grant: Grant) -> Result<bool, Error> {
        Worker::renew(self, grant)
    }
    fn receive_end(&self, media: String, signal: Signal) -> Result<bool, Error> {
        Worker::receive_end(self, media, signal)
    }
    fn invalidate(&self, binding: Binding) -> Result<(), Error> {
        Worker::invalidate(self, binding)
    }
    fn interrupt(&self) -> Result<(), Error> {
        Worker::interrupt(self)
    }
    fn revoke(&self) -> Result<(), Error> {
        Worker::revoke(self)
    }
    fn input(&self, grant: Grant, event: Event) -> Result<(), Error> {
        Worker::input(self, grant, event)
    }
    fn flush(&self) -> Result<Status, Error> {
        Worker::flush(self)
    }
    fn status(&self) -> Status {
        Worker::status(self)
    }
    fn shutdown(&mut self) {
        Worker::shutdown(self);
    }
}
