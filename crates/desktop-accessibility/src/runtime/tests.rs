use super::*;
use crate::*;
use std::{cell::RefCell, collections::VecDeque, rc::Rc, thread};

struct Script(VecDeque<Wake>);
impl EventRuntime for Script {
    fn next(&mut self) -> Wake {
        self.0.pop_front().unwrap()
    }
}
struct LocalBackend {
    // Deliberately !Send: a runtime must never move native elements across threads.
    log: Rc<RefCell<Vec<&'static str>>>,
    owner: thread::ThreadId,
}
impl Drop for LocalBackend {
    fn drop(&mut self) {
        assert_eq!(thread::current().id(), self.owner);
        self.log.borrow_mut().push("drop");
    }
}
impl Backend for LocalBackend {
    type Element = Rc<()>;
    fn capabilities(&self) -> Capabilities {
        assert_eq!(thread::current().id(), self.owner);
        self.log.borrow_mut().push("capabilities");
        Capabilities {
            supported: true,
            backend: Some("test"),
            actions: &[],
            features: Some(Features::new(false, false, false)),
        }
    }
    fn roots(&mut self, _: usize, _: &Check) -> Result<(Vec<Self::Element>, bool)> {
        Err(Error::Unsupported)
    }
    fn children(
        &mut self,
        _: &Self::Element,
        _: usize,
        _: &Check,
    ) -> Result<(Vec<Self::Element>, bool)> {
        Err(Error::Unsupported)
    }
    fn inspect(&mut self, _: &Self::Element, _: &ReadOptions, _: &Check) -> Result<ElementInfo> {
        Err(Error::Unsupported)
    }
    fn perform(&mut self, _: &Self::Element, _: Action, _: Option<&str>, _: &Check) -> Result<()> {
        Err(Error::Unsupported)
    }
}
fn work(operation: Operation, allowed: bool) -> (Wake, mpsc::Receiver<Result<Response>>) {
    let (answer, rx) = mpsc::channel();
    let check: Check = Arc::new(move || {
        if allowed {
            Ok(())
        } else {
            Err(Error::Cancelled)
        }
    });
    (
        Wake::Work(Work {
            operation,
            access: Access {
                owner: "test".into(),
                check: check.clone(),
                lease: check,
            },
            answer,
        }),
        rx,
    )
}
#[test]
fn alternate_runtime_preserves_lazy_retry_authority_and_native_thread_lifetime() {
    let (cleanup, cleanup_result) = work(Operation::Cleanup, false);
    let (cancelled, cancelled_result) = work(Operation::Call(Request::Capabilities), false);
    let (unavailable, unavailable_result) = work(Operation::Call(Request::Capabilities), true);
    let (request, result) = work(Operation::Call(Request::Capabilities), true);
    let log = Rc::new(RefCell::new(Vec::new()));
    let mut creates = 0;
    run(
        Script(VecDeque::from([
            cleanup,
            cancelled,
            unavailable,
            request,
            Wake::Maintenance,
            Wake::Closed,
        ])),
        || {
            creates += 1;
            if creates == 1 {
                return Err(Error::ProviderUnavailable);
            }
            log.borrow_mut().push("create");
            Ok(LocalBackend {
                log: log.clone(),
                owner: thread::current().id(),
            })
        },
    );
    assert!(cleanup_result.recv().unwrap().is_ok());
    assert!(matches!(
        cancelled_result.recv().unwrap(),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        unavailable_result.recv().unwrap(),
        Err(Error::ProviderUnavailable)
    ));
    let Response::Value(report) = result.recv().unwrap().unwrap() else {
        panic!("wrong response")
    };
    assert_eq!(report["backend"], "test");
    assert_eq!(report["supportsWait"], false);
    assert_eq!(creates, 2);
    assert_eq!(*log.borrow(), ["create", "capabilities", "drop"]);
}
