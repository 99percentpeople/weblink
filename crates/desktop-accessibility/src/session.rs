use crate::*;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(60);
const MAX_REFERENCES: usize = 2048;
const MAX_SUBSCRIPTIONS: usize = 4;
struct Subscription {
    _guard: Box<dyn EventSubscription>,
    signal: Arc<WaitSignal>,
    owner: String,
}
struct Reference<E> {
    element: E,
    owner: String,
    expires: Instant,
    lease: Check,
}
pub(crate) struct Session<B: Backend> {
    // Drop event handlers and native references before the backend's COM apartment.
    subscriptions: Vec<Subscription>,
    references: HashMap<String, Reference<B::Element>>,
    backend: B,
}
impl<B: Backend> Session<B> {
    pub fn new(backend: B) -> Self {
        Self {
            subscriptions: Vec::new(),
            backend,
            references: HashMap::new(),
        }
    }
    pub fn purge(&mut self) {
        self.subscriptions.retain(|s| !s.signal.is_cancelled());
        self.references
            .retain(|_, r| r.expires > Instant::now() && (r.lease)().is_ok());
    }
    pub fn subscribe(
        &mut self,
        element_id: &str,
        condition: &WaitCondition,
        signal: Arc<WaitSignal>,
        mut access: Access,
        registration_check: Check,
    ) -> Result<Access> {
        condition.validate()?;
        (access.check)()?;
        self.purge();
        if self.subscriptions.len() >= MAX_SUBSCRIPTIONS {
            return Err(Error::Busy);
        }
        let element = self.resolve(element_id, &mut access)?;
        let original_check = access.check.clone();
        let bounded: Check = Arc::new(move || {
            registration_check()?;
            original_check()
        });
        let guard = self
            .backend
            .subscribe(&element, condition, signal.clone(), &bounded)?;
        bounded()?;
        if signal.is_cancelled() {
            return Err(Error::Cancelled);
        }
        self.subscriptions.push(Subscription {
            _guard: guard,
            signal,
            owner: access.owner.clone(),
        });
        // The waiting thread must also enforce the original reference's read grant/TTL.
        Ok(access)
    }
    fn resolve(&self, id: &str, access: &mut Access) -> Result<B::Element> {
        let r = self.references.get(id).ok_or(Error::StaleElement)?;
        if r.owner != access.owner {
            return Err(Error::PermissionDenied);
        }
        if r.expires <= Instant::now() {
            return Err(Error::StaleElement);
        }
        (r.lease)()?;
        let lease = r.lease.clone();
        let check = access.check.clone();
        let expires = r.expires;
        access.lease = lease.clone();
        access.check = Arc::new(move || {
            if expires <= Instant::now() {
                return Err(Error::StaleElement);
            }
            lease()?;
            check()
        });
        Ok(r.element.clone())
    }
    fn remember(&mut self, element: B::Element, access: &Access) -> String {
        if self.references.len() >= MAX_REFERENCES {
            if let Some(oldest) = self
                .references
                .iter()
                .min_by_key(|(_, r)| r.expires)
                .map(|(id, _)| id.clone())
            {
                self.references.remove(&oldest);
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.references.insert(
            id.clone(),
            Reference {
                element,
                owner: access.owner.clone(),
                expires: Instant::now() + TTL,
                lease: access.lease.clone(),
            },
        );
        id
    }
    pub fn bind_window(&mut self, id: &str, mut access: Access) -> Result<BoundWindow> {
        (access.check)()?;
        self.purge();
        let element = self.resolve(id, &mut access)?;
        let info = self
            .backend
            .inspect(&element, &ReadOptions::default(), &access.check)?;
        if info.protected {
            return Err(Error::ProtectedElement);
        }
        if !info.enabled {
            return Err(Error::ElementDisabled);
        }
        (access.check)()?;
        let window = self.backend.bind_window(&element, &access.check)?;
        (access.check)()?;
        Ok(window)
    }
    pub fn execute(&mut self, request: Request, mut access: Access) -> Result<Value> {
        request.validate()?;
        (access.check)()?;
        self.purge();
        let result = match request {
            Request::Capabilities => {
                json!({"supported":true,"backend":self.backend.name(),"actions":ACTIONS,
                "maxNodes":256,"maxDepth":8,"referenceTtlMs":60000,"coordinateSpace":"desktopPhysicalPixels",
                "maxTextLength":4096,"supportsWait":true,"supportsObservation":true})
            }
            Request::Windows { limit } => {
                let (elements, truncated) = self.backend.roots(limit, &access.check)?;
                let mut nodes = Vec::new();
                for element in elements {
                    (access.check)()?;
                    let mut info =
                        match self
                            .backend
                            .inspect(&element, &ReadOptions::default(), &access.check)
                        {
                            Ok(info) => info,
                            Err(Error::ProtectedElement | Error::StaleElement) => continue,
                            Err(e) => return Err(e),
                        };
                    info.sanitize(&ReadOptions::default());
                    let element_id = self.remember(element, &access);
                    nodes.push(Node {
                        element_id,
                        parent_id: None,
                        depth: 0,
                        info,
                    });
                }
                json!({"coordinateSpace":"desktopPhysicalPixels","windows":nodes,"truncated":truncated,"referenceTtlMs":60000})
            }
            Request::Snapshot {
                element_id,
                max_depth,
                max_nodes,
                options,
            } => {
                let root = self.resolve(&element_id, &mut access)?;
                self.snapshot(
                    root,
                    Some(element_id),
                    max_depth,
                    max_nodes,
                    &options,
                    &access,
                )?
            }
            Request::Inspect {
                element_id,
                options,
                refresh_when,
            } => {
                let element = self.resolve(&element_id, &mut access)?;
                let mut info = self.backend.inspect(&element, &options, &access.check)?;
                if info.protected {
                    return Err(Error::ProtectedElement);
                }
                info.sanitize(&options);
                let mut node = json!(Node {
                    element_id,
                    parent_id: None,
                    depth: 0,
                    info
                });
                // Never churn the bounded reference cache while observing events. A full
                // cache must not evict this wait's oldest target before its condition can match.
                // Evaluate and refresh from one observation, not a second provider request.
                if refresh_when
                    .as_ref()
                    .is_some_and(|condition| condition.matches(&node))
                {
                    node["elementId"] = json!(self.remember(element, &access));
                }
                node
            }
            // Client waits on events between worker requests, never on this thread.
            Request::Wait(_) => return Err(Error::InvalidArguments),
            Request::Action {
                element_id,
                action,
                value,
                observe_after,
            } => {
                let element = self.resolve(&element_id, &mut access)?;
                let info =
                    self.backend
                        .inspect(&element, &ReadOptions::default(), &access.check)?;
                if info.protected {
                    return Err(Error::ProtectedElement);
                }
                if !info.enabled {
                    return Err(Error::ElementDisabled);
                }
                if !info.actions.contains(&action) {
                    return Err(Error::UnsupportedAction);
                }
                // Resolve before invalidating references. Never reselect a vanished element by label.
                // Both roots retain their original independent read grants in addition to this call's authority.
                let observation = observe_after
                    .map(|options| {
                        let mut read_access = access.clone();
                        let root = self.resolve(
                            options.element_id.as_deref().unwrap_or(&element_id),
                            &mut read_access,
                        )?;
                        Ok::<_, Error>((root, options, read_access))
                    })
                    .transpose()?;
                // Actions can replace controls, including on an error/timeout. Never reuse these references.
                self.references.retain(|_, r| r.owner != access.owner);
                for subscription in &self.subscriptions {
                    if subscription.owner == access.owner {
                        subscription.signal.notify();
                    }
                }
                (access.check)()?;
                self.backend
                    .perform(&element, action, value.as_deref(), &access.check)?;
                let mut result = json!({"applied":true,"refreshRequired":true});
                if let Some((root, options, read_access)) = observation {
                    // Client consumes this internal request before exposing the result. The second
                    // worker request gets its own bounded wait, so an unresponsive observation
                    // provider cannot erase the successfully applied action's acknowledgement.
                    result["_observation"] = json!({
                        "elementId":self.remember(root, &read_access),
                        "maxDepth":options.max_depth,"maxNodes":options.max_nodes,
                        "includeValues":options.include_values,"maxTextLength":options.max_text_length,
                    });
                }
                // A completed action must not be reported as failed merely because its optional
                // observation (including a post-action authority check) failed. No UI data escapes on that path.
                return Ok(result);
            }
        };
        (access.check)()?;
        Ok(result)
    }

    fn snapshot(
        &mut self,
        root: B::Element,
        root_id: Option<String>,
        max_depth: usize,
        max_nodes: usize,
        options: &ReadOptions,
        access: &Access,
    ) -> Result<Value> {
        let mut queue = VecDeque::from([(root, None, 0usize, root_id)]);
        let mut nodes = Vec::new();
        let mut truncated = false;
        while let Some((element, parent_id, depth, existing_id)) = queue.pop_front() {
            (access.check)()?;
            let mut info = self.backend.inspect(&element, options, &access.check)?;
            info.sanitize(options);
            let id = existing_id.unwrap_or_else(|| self.remember(element.clone(), access));
            if !info.protected {
                let remaining = max_nodes.saturating_sub(nodes.len() + queue.len() + 1);
                if depth < max_depth && remaining > 0 {
                    let (children, more) =
                        self.backend.children(&element, remaining, &access.check)?;
                    truncated |= more;
                    queue.extend(
                        children
                            .into_iter()
                            .map(|e| (e, Some(id.clone()), depth + 1, None)),
                    );
                } else {
                    let (children, more) = self.backend.children(&element, 1, &access.check)?;
                    truncated |= more || !children.is_empty();
                }
            }
            nodes.push(Node {
                element_id: id,
                parent_id,
                depth,
                info,
            });
        }
        (access.check)()?;
        Ok(
            json!({"coordinateSpace":"desktopPhysicalPixels","nodes":nodes,"truncated":truncated,"referenceTtlMs":60000}),
        )
    }
}

#[cfg(test)]
mod tests;
