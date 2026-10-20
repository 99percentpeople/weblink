use crate::*;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

const TTL: Duration = Duration::from_secs(60);
const MAX_REFERENCES: usize = 2048;
struct Reference<E> {
    element: E,
    owner: String,
    expires: Instant,
    lease: Check,
}
pub(crate) struct Session<B: Backend> {
    backend: B,
    references: HashMap<String, Reference<B::Element>>,
}
impl<B: Backend> Session<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            references: HashMap::new(),
        }
    }
    pub fn purge(&mut self) {
        self.references
            .retain(|_, r| r.expires > Instant::now() && (r.lease)().is_ok());
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
        let info = self.backend.inspect(&element, &access.check)?;
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
                "maxNodes":256,"maxDepth":8,"referenceTtlMs":60000,"coordinateSpace":"desktopPhysicalPixels"})
            }
            Request::Windows { limit } => {
                let (elements, truncated) = self.backend.roots(limit, &access.check)?;
                let mut nodes = Vec::new();
                for element in elements {
                    (access.check)()?;
                    let mut info = match self.backend.inspect(&element, &access.check) {
                        Ok(info) => info,
                        Err(Error::ProtectedElement | Error::StaleElement) => continue,
                        Err(e) => return Err(e),
                    };
                    info.redact();
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
            } => {
                let root = self.resolve(&element_id, &mut access)?;
                let mut queue = VecDeque::from([(root, None, 0usize, Some(element_id))]);
                let mut nodes = Vec::new();
                let mut truncated = false;
                while let Some((element, parent_id, depth, existing_id)) = queue.pop_front() {
                    (access.check)()?;
                    let mut info = self.backend.inspect(&element, &access.check)?;
                    info.redact();
                    let id = existing_id.unwrap_or_else(|| self.remember(element.clone(), &access));
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
                            let (children, more) =
                                self.backend.children(&element, 1, &access.check)?;
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
                json!({"coordinateSpace":"desktopPhysicalPixels","nodes":nodes,"truncated":truncated,"referenceTtlMs":60000})
            }
            Request::Action {
                element_id,
                action,
                value,
            } => {
                let element = self.resolve(&element_id, &mut access)?;
                let info = self.backend.inspect(&element, &access.check)?;
                if info.protected {
                    return Err(Error::ProtectedElement);
                }
                if !info.enabled {
                    return Err(Error::ElementDisabled);
                }
                if !info.actions.contains(&action) {
                    return Err(Error::UnsupportedAction);
                }
                // Actions can replace controls, including on an error/timeout. Never reuse these references.
                self.references.retain(|_, r| r.owner != access.owner);
                (access.check)()?;
                self.backend
                    .perform(&element, action, value.as_deref(), &access.check)?;
                json!({"applied":true,"refreshRequired":true})
            }
        };
        (access.check)()?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
