//! Event subscriptions are created and dropped only on the existing COM MTA worker.
//! Callbacks may arrive concurrently, including after removal: their only effect is
//! to notify an Arc-owned signal. They never inspect a sender or touch permissions.
use super::{mapped, Element};
use crate::{Check, Error, EventSubscription, Result, WaitCondition, WaitSignal};
use ::windows::{
    core::{implement, Interface, Ref},
    Win32::{
        System::{Com::SAFEARRAY, Variant::VARIANT},
        UI::Accessibility::*,
    },
};
use std::sync::Arc;

#[implement(
    IUIAutomationPropertyChangedEventHandler,
    IUIAutomationEventHandler,
    IUIAutomationFocusChangedEventHandler,
    IUIAutomationStructureChangedEventHandler
)]
struct WakeHandler {
    signal: Arc<WaitSignal>,
}

#[allow(non_snake_case)]
impl IUIAutomationPropertyChangedEventHandler_Impl for WakeHandler_Impl {
    fn HandlePropertyChangedEvent(
        &self,
        _sender: Ref<'_, IUIAutomationElement>,
        _propertyid: UIA_PROPERTY_ID,
        _newvalue: &VARIANT,
    ) -> ::windows::core::Result<()> {
        self.signal.notify();
        Ok(())
    }
}
#[allow(non_snake_case)]
impl IUIAutomationEventHandler_Impl for WakeHandler_Impl {
    fn HandleAutomationEvent(
        &self,
        _sender: Ref<'_, IUIAutomationElement>,
        _eventid: UIA_EVENT_ID,
    ) -> ::windows::core::Result<()> {
        self.signal.notify();
        Ok(())
    }
}
#[allow(non_snake_case)]
impl IUIAutomationFocusChangedEventHandler_Impl for WakeHandler_Impl {
    fn HandleFocusChangedEvent(
        &self,
        _sender: Ref<'_, IUIAutomationElement>,
    ) -> ::windows::core::Result<()> {
        self.signal.notify();
        Ok(())
    }
}
#[allow(non_snake_case)]
impl IUIAutomationStructureChangedEventHandler_Impl for WakeHandler_Impl {
    fn HandleStructureChangedEvent(
        &self,
        _sender: Ref<'_, IUIAutomationElement>,
        _changetype: StructureChangeType,
        _runtimeid: *const SAFEARRAY,
    ) -> ::windows::core::Result<()> {
        self.signal.notify();
        Ok(())
    }
}

struct EventPlan {
    properties: Vec<UIA_PROPERTY_ID>,
    events: Vec<UIA_EVENT_ID>,
    focus: bool,
}
impl EventPlan {
    fn for_condition(condition: &WaitCondition) -> Self {
        // Protection changes must invalidate an otherwise idle wait without reading contents.
        let mut properties = vec![UIA_IsPasswordPropertyId];
        for (needed, property) in [
            (condition.enabled.is_some(), UIA_IsEnabledPropertyId),
            (condition.focused.is_some(), UIA_HasKeyboardFocusPropertyId),
            (condition.offscreen.is_some(), UIA_IsOffscreenPropertyId),
            (
                condition.selected.is_some(),
                UIA_SelectionItemIsSelectedPropertyId,
            ),
            (
                condition.toggle_state.is_some(),
                UIA_ToggleToggleStatePropertyId,
            ),
            (
                condition.expand_collapse_state.is_some(),
                UIA_ExpandCollapseExpandCollapseStatePropertyId,
            ),
            (condition.value.is_some(), UIA_ValueValuePropertyId),
            (condition.name.is_some(), UIA_NamePropertyId),
        ] {
            if needed {
                properties.push(property);
            }
        }
        let mut events = Vec::new();
        if condition.text_contains.is_some() {
            events.push(UIA_Text_TextChangedEventId);
        }
        if condition.selected.is_some() {
            events.extend([
                UIA_SelectionItem_ElementSelectedEventId,
                UIA_SelectionItem_ElementAddedToSelectionEventId,
                UIA_SelectionItem_ElementRemovedFromSelectionEventId,
            ]);
        }
        Self {
            properties,
            events,
            focus: condition.focused.is_some(),
        }
    }
}

/// This guard contains !Send COM interfaces and stays in Session on the MTA worker.
/// It must be dropped before the backend's COM apartment is uninitialized.
struct Subscription {
    automation: IUIAutomation,
    target: IUIAutomationElement,
    root: IUIAutomationElement,
    property_handler: IUIAutomationPropertyChangedEventHandler,
    event_handler: IUIAutomationEventHandler,
    focus_handler: IUIAutomationFocusChangedEventHandler,
    structure_handler: IUIAutomationStructureChangedEventHandler,
    properties_registered: bool,
    events_registered: Vec<UIA_EVENT_ID>,
    focus_registered: bool,
    structure_registered: bool,
}
impl EventSubscription for Subscription {}
impl Drop for Subscription {
    fn drop(&mut self) {
        // Roll back partial registration as well. RemoveAllEventHandlers is deliberately
        // avoided: another caller can own a concurrent wait on this same UIA client.
        unsafe {
            if self.structure_registered {
                let _ = self
                    .automation
                    .RemoveStructureChangedEventHandler(&self.root, &self.structure_handler);
            }
            if self.focus_registered {
                let _ = self
                    .automation
                    .RemoveFocusChangedEventHandler(&self.focus_handler);
            }
            for event in self.events_registered.iter().rev() {
                let _ = self.automation.RemoveAutomationEventHandler(
                    *event,
                    &self.target,
                    &self.event_handler,
                );
            }
            if self.properties_registered {
                let _ = self
                    .automation
                    .RemovePropertyChangedEventHandler(&self.target, &self.property_handler);
            }
        }
    }
}

fn registration_error(error: ::windows::core::Error) -> Error {
    match mapped(error) {
        Error::UnsupportedAction => Error::Unsupported,
        error => error,
    }
}

pub(super) fn subscribe(
    automation: &IUIAutomation,
    element: &Element,
    condition: &WaitCondition,
    signal: Arc<WaitSignal>,
    check: &Check,
) -> Result<Box<dyn EventSubscription>> {
    condition.validate()?;
    check()?;
    let plan = EventPlan::for_condition(condition);
    let property_handler: IUIAutomationPropertyChangedEventHandler = WakeHandler { signal }.into();
    let mut subscription = Subscription {
        automation: automation.clone(),
        target: element.raw.clone(),
        root: element.root.clone(),
        event_handler: property_handler.cast().map_err(registration_error)?,
        focus_handler: property_handler.cast().map_err(registration_error)?,
        structure_handler: property_handler.cast().map_err(registration_error)?,
        property_handler,
        properties_registered: false,
        events_registered: vec![],
        focus_registered: false,
        structure_registered: false,
    };
    unsafe {
        // Track the attempted registration first so failure also triggers best-effort removal.
        subscription.properties_registered = true;
        automation
            .AddPropertyChangedEventHandlerNativeArray(
                &subscription.target,
                TreeScope_Element,
                None::<&IUIAutomationCacheRequest>,
                &subscription.property_handler,
                &plan.properties,
            )
            .map_err(registration_error)?;
        for event in plan.events {
            check()?;
            subscription.events_registered.push(event);
            let scope = if event == UIA_Text_TextChangedEventId {
                TreeScope_Subtree
            } else {
                TreeScope_Element
            };
            automation
                .AddAutomationEventHandler(
                    event,
                    &subscription.target,
                    scope,
                    None::<&IUIAutomationCacheRequest>,
                    &subscription.event_handler,
                )
                .map_err(registration_error)?;
        }
        if plan.focus {
            check()?;
            subscription.focus_registered = true;
            // UIA focus events are global. The callback only wakes a fresh inspection of
            // the original target; it never resolves or exports the event's sender.
            automation
                .AddFocusChangedEventHandler(
                    None::<&IUIAutomationCacheRequest>,
                    &subscription.focus_handler,
                )
                .map_err(registration_error)?;
        }
        check()?;
        subscription.structure_registered = true;
        // A child can disappear without another property event on that child. Listen
        // within its original window so the next inspection can reject stale identity.
        automation
            .AddStructureChangedEventHandler(
                &subscription.root,
                TreeScope_Subtree,
                None::<&IUIAutomationCacheRequest>,
                &subscription.structure_handler,
            )
            .map_err(registration_error)?;
    }
    check()?;
    Ok(Box::new(subscription))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_state_wait_does_not_subscribe_to_unrelated_text_or_focus_events() {
        let plan = EventPlan::for_condition(&WaitCondition {
            toggle_state: Some(crate::ToggleState::On),
            ..Default::default()
        });
        assert_eq!(
            plan.properties,
            vec![UIA_IsPasswordPropertyId, UIA_ToggleToggleStatePropertyId]
        );
        assert!(plan.events.is_empty());
        assert!(!plan.focus);
    }
    #[test]
    fn text_and_selection_waits_register_only_their_relevant_automation_events() {
        let plan = EventPlan::for_condition(&WaitCondition {
            text_contains: Some("ready".into()),
            selected: Some(true),
            focused: Some(true),
            ..Default::default()
        });
        assert!(plan
            .properties
            .contains(&UIA_SelectionItemIsSelectedPropertyId));
        assert!(plan.properties.contains(&UIA_HasKeyboardFocusPropertyId));
        assert!(!plan.properties.contains(&UIA_ValueValuePropertyId));
        assert_eq!(
            plan.events,
            vec![
                UIA_Text_TextChangedEventId,
                UIA_SelectionItem_ElementSelectedEventId,
                UIA_SelectionItem_ElementAddedToSelectionEventId,
                UIA_SelectionItem_ElementRemovedFromSelectionEventId,
            ]
        );
        assert!(plan.focus);
    }
}
