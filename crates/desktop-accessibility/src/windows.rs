//! UIA COM objects are created, used and released on the dedicated MTA worker.
mod events;
use crate::*;
use ::windows::{
    core::{Interface, BSTR},
    Win32::{
        Foundation::E_ACCESSDENIED,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::Accessibility::*,
    },
};

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
pub(crate) struct Windows {
    automation: IUIAutomation,
    walker: IUIAutomationTreeWalker,
    raw_walker: IUIAutomationTreeWalker,
    // Drop COM interfaces before uninitializing their apartment.
    _apartment: Apartment,
}
#[derive(Clone)]
pub(crate) struct Element {
    raw: IUIAutomationElement,
    root: IUIAutomationElement,
}
fn mapped(error: ::windows::core::Error) -> Error {
    match error.code().0 as u32 {
        UIA_E_ELEMENTNOTAVAILABLE => Error::StaleElement,
        UIA_E_ELEMENTNOTENABLED => Error::ElementDisabled,
        UIA_E_NOTSUPPORTED => Error::UnsupportedAction,
        UIA_E_TIMEOUT => Error::Timeout,
        code if code == E_ACCESSDENIED.0 as u32 => Error::PermissionDenied,
        _ => Error::ProviderUnavailable,
    }
}
fn optional(
    result: ::windows::core::Result<IUIAutomationElement>,
) -> Result<Option<IUIAutomationElement>> {
    match result {
        Ok(element) => Ok(Some(element)),
        // UIA reports a missing tree sibling/parent as S_OK with a null COM pointer.
        // windows-core 0.62 converts a successful null interface into Error::empty (S_OK).
        Err(e) if e.code().is_ok() => Ok(None),
        Err(e) => Err(mapped(e)),
    }
}
impl Windows {
    pub fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(mapped)?;
            let apartment = Apartment;
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).map_err(mapped)?;
            let timed: IUIAutomation2 = automation.cast().map_err(mapped)?;
            timed.SetConnectionTimeout(500).map_err(mapped)?;
            timed.SetTransactionTimeout(500).map_err(mapped)?;
            let walker = automation.ControlViewWalker().map_err(mapped)?;
            let raw_walker = automation.RawViewWalker().map_err(mapped)?;
            Ok(Self {
                automation,
                walker,
                raw_walker,
                _apartment: apartment,
            })
        }
    }
    /// Checking every ancestor also excludes WebView subprocess controls hosted by this app.
    /// A changed/reparented element must still belong to its original window.
    fn allowed(&self, element: &Element, check: &Check) -> Result<()> {
        unsafe {
            let mut current = Some(element.raw.clone());
            let mut found_root = false;
            for _ in 0..64 {
                check()?;
                let Some(node) = current else {
                    return if found_root {
                        Ok(())
                    } else {
                        Err(Error::StaleElement)
                    };
                };
                if node.CurrentProcessId().map_err(mapped)? as u32 == std::process::id() {
                    return Err(Error::ProtectedElement);
                }
                if !self
                    .automation
                    .CompareElements(&node, &element.raw)
                    .map_err(mapped)?
                    .as_bool()
                    && node.CurrentIsPassword().map_err(mapped)?.as_bool()
                {
                    return Err(Error::ProtectedElement);
                }
                found_root |= self
                    .automation
                    .CompareElements(&node, &element.root)
                    .map_err(mapped)?
                    .as_bool();
                current = optional(self.raw_walker.GetParentElement(&node))?;
            }
            Err(Error::ProtectedElement)
        }
    }
    fn enumerate(
        &self,
        parent: &IUIAutomationElement,
        root: Option<&IUIAutomationElement>,
        limit: usize,
        check: &Check,
    ) -> Result<(Vec<Element>, bool)> {
        unsafe {
            let mut current = optional(self.walker.GetFirstChildElement(parent))?;
            let mut elements = Vec::new();
            let mut visited = 0;
            while let Some(raw) = current {
                check()?;
                visited += 1;
                if elements.len() >= limit || visited > 512 {
                    return Ok((elements, true));
                }
                let element = Element {
                    root: root.unwrap_or(&raw).clone(),
                    raw: raw.clone(),
                };
                match self.allowed(&element, check) {
                    Ok(()) => elements.push(element),
                    Err(Error::ProtectedElement | Error::StaleElement) => {}
                    Err(e) => return Err(e),
                }
                current = optional(self.walker.GetNextSiblingElement(&raw))?;
            }
            Ok((elements, false))
        }
    }
}
impl Backend for Windows {
    type Element = Element;
    fn subscribe(
        &mut self,
        element: &Element,
        condition: &WaitCondition,
        signal: Arc<WaitSignal>,
        check: &Check,
    ) -> Result<Box<dyn EventSubscription>> {
        self.allowed(element, check)?;
        if unsafe { element.raw.CurrentIsPassword().map_err(mapped)?.as_bool() } {
            return Err(Error::ProtectedElement);
        }
        let subscription = events::subscribe(&self.automation, element, condition, signal, check)?;
        // The provider and permission state can change during registration.
        self.allowed(element, check)?;
        if unsafe { element.raw.CurrentIsPassword().map_err(mapped)?.as_bool() } {
            return Err(Error::ProtectedElement);
        }
        check()?;
        Ok(subscription)
    }
    fn bind_window(&mut self, element: &Element, check: &Check) -> Result<BoundWindow> {
        self.allowed(element, check)?;
        unsafe {
            if !self
                .automation
                .CompareElements(&element.raw, &element.root)
                .map_err(mapped)?
                .as_bool()
            {
                return Err(Error::InvalidArguments);
            }
            let hwnd = element.raw.CurrentNativeWindowHandle().map_err(mapped)?;
            let process = element.raw.CurrentProcessId().map_err(mapped)? as u32;
            check()?;
            let guard = weblink_desktop_input::windows::window::bind(hwnd.0 as isize, process)
                .map_err(|_| Error::StaleElement)?;
            // Recheck the original provider reference after placing the lifetime marker.
            self.allowed(element, check)?;
            if element.raw.CurrentNativeWindowHandle().map_err(mapped)? != hwnd {
                return Err(Error::StaleElement);
            }
            Ok(guard)
        }
    }
    fn name(&self) -> &'static str {
        "windows-uia"
    }
    fn roots(&mut self, limit: usize, check: &Check) -> Result<(Vec<Element>, bool)> {
        let root = unsafe { self.automation.GetRootElement().map_err(mapped)? };
        self.enumerate(&root, None, limit, check)
    }
    fn children(
        &mut self,
        element: &Element,
        limit: usize,
        check: &Check,
    ) -> Result<(Vec<Element>, bool)> {
        self.allowed(element, check)?;
        unsafe {
            if element.raw.CurrentIsPassword().map_err(mapped)?.as_bool() {
                return Ok((vec![], false));
            }
        }
        self.enumerate(&element.raw, Some(&element.root), limit, check)
    }
    fn inspect(
        &mut self,
        element: &Element,
        options: &ReadOptions,
        check: &Check,
    ) -> Result<ElementInfo> {
        self.allowed(element, check)?;
        unsafe {
            let raw = &element.raw;
            // Do not request names, patterns or content from protected controls.
            let mut protected = raw.CurrentIsPassword().map_err(mapped)?.as_bool();
            let enabled = raw.CurrentIsEnabled().map_err(mapped)?.as_bool();
            let mut actions = vec![];
            let mut state = ElementState::default();
            if !protected {
                check()?;
                if enabled && raw.CurrentIsKeyboardFocusable().map_err(mapped)?.as_bool() {
                    actions.push(Action::Focus);
                }
                if enabled
                    && raw
                        .GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
                        .is_ok()
                {
                    actions.push(Action::Invoke);
                }
                check()?;
                if let Ok(pattern) =
                    raw.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                {
                    let read_only = pattern.CurrentIsReadOnly().map_err(mapped)?.as_bool();
                    state.read_only = Some(read_only);
                    if enabled && !read_only {
                        actions.push(Action::SetValue);
                    }
                    if options.include_values {
                        check()?;
                        // Recheck immediately before content access; applications may change protection.
                        protected |= raw.CurrentIsPassword().map_err(mapped)?.as_bool();
                        if !protected {
                            state.value = Some(pattern.CurrentValue().map_err(mapped)?.to_string());
                        }
                    }
                }
                check()?;
                if !protected {
                    if let Ok(pattern) =
                        raw.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
                    {
                        state.toggle_state =
                            Some(match pattern.CurrentToggleState().map_err(mapped)? {
                                state if state == ToggleState_On => crate::ToggleState::On,
                                state if state == ToggleState_Off => crate::ToggleState::Off,
                                _ => crate::ToggleState::Indeterminate,
                            });
                        if enabled {
                            actions.push(Action::Toggle);
                        }
                    }
                    check()?;
                    if let Ok(pattern) = raw
                        .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                            UIA_SelectionItemPatternId,
                        )
                    {
                        state.selected =
                            Some(pattern.CurrentIsSelected().map_err(mapped)?.as_bool());
                        if enabled {
                            actions.push(Action::Select);
                        }
                    }
                    check()?;
                    if let Ok(pattern) = raw
                        .GetCurrentPatternAs::<IUIAutomationExpandCollapsePattern>(
                            UIA_ExpandCollapsePatternId,
                        )
                    {
                        let expanded = match pattern.CurrentExpandCollapseState().map_err(mapped)? {
                            state if state == ExpandCollapseState_Collapsed => {
                                crate::ExpandCollapseState::Collapsed
                            }
                            state if state == ExpandCollapseState_Expanded => {
                                crate::ExpandCollapseState::Expanded
                            }
                            state if state == ExpandCollapseState_PartiallyExpanded => {
                                crate::ExpandCollapseState::PartiallyExpanded
                            }
                            _ => crate::ExpandCollapseState::LeafNode,
                        };
                        state.expand_collapse_state = Some(expanded);
                        if enabled && expanded != crate::ExpandCollapseState::LeafNode {
                            actions.extend([Action::Expand, Action::Collapse]);
                        }
                    }
                    check()?;
                    if enabled
                        && raw
                            .GetCurrentPatternAs::<IUIAutomationScrollItemPattern>(
                                UIA_ScrollItemPatternId,
                            )
                            .is_ok()
                    {
                        actions.push(Action::ScrollIntoView);
                    }
                    if options.include_values {
                        check()?;
                        protected |= raw.CurrentIsPassword().map_err(mapped)?.as_bool();
                        if !protected {
                            if let Ok(pattern) = raw
                                .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                            {
                                let range = pattern.DocumentRange().map_err(mapped)?;
                                check()?;
                                protected |= raw.CurrentIsPassword().map_err(mapped)?.as_bool();
                                if !protected {
                                    // UIA providers may count UTF-16 code units. Reserve two units
                                    // per Unicode scalar plus a sentinel before Unicode-safe truncation.
                                    state.text = Some(
                                        range
                                            .GetText((options.max_text_length * 2 + 2) as i32)
                                            .map_err(mapped)?
                                            .to_string(),
                                    );
                                }
                            }
                        }
                    }
                }
            }
            check()?;
            protected |= raw.CurrentIsPassword().map_err(mapped)?.as_bool();
            let rect = raw.CurrentBoundingRectangle().map_err(mapped)?;
            let mut info = ElementInfo {
                role: role(raw.CurrentControlType().map_err(mapped)?),
                name: if protected {
                    String::new()
                } else {
                    raw.CurrentName().map_err(mapped)?.to_string()
                },
                automation_id: if protected {
                    String::new()
                } else {
                    raw.CurrentAutomationId().map_err(mapped)?.to_string()
                },
                process_id: raw.CurrentProcessId().map_err(mapped)? as u32,
                bounds: Bounds {
                    x: rect.left,
                    y: rect.top,
                    width: rect.right.saturating_sub(rect.left).max(0),
                    height: rect.bottom.saturating_sub(rect.top).max(0),
                },
                enabled,
                focused: raw.CurrentHasKeyboardFocus().map_err(mapped)?.as_bool(),
                offscreen: raw.CurrentIsOffscreen().map_err(mapped)?.as_bool(),
                protected,
                actions,
                state,
            };
            info.sanitize(options);
            check()?;
            Ok(info)
        }
    }
    fn perform(
        &mut self,
        element: &Element,
        action: Action,
        value: Option<&str>,
        check: &Check,
    ) -> Result<()> {
        self.allowed(element, check)?;
        unsafe {
            let raw = &element.raw;
            let validate = || -> Result<()> {
                self.allowed(element, check)?;
                if raw.CurrentIsPassword().map_err(mapped)?.as_bool() {
                    return Err(Error::ProtectedElement);
                }
                if !raw.CurrentIsEnabled().map_err(mapped)?.as_bool() {
                    return Err(Error::ElementDisabled);
                }
                check()
            };
            macro_rules! pattern {
                ($ty:ty, $id:expr, $method:ident) => {{
                    let p = raw
                        .GetCurrentPatternAs::<$ty>($id)
                        .map_err(|_| Error::UnsupportedAction)?;
                    validate()?;
                    p.$method().map_err(mapped)
                }};
            }
            match action {
                Action::Focus => {
                    validate()?;
                    raw.SetFocus().map_err(mapped)
                }
                Action::Invoke => pattern!(IUIAutomationInvokePattern, UIA_InvokePatternId, Invoke),
                Action::Toggle => pattern!(IUIAutomationTogglePattern, UIA_TogglePatternId, Toggle),
                Action::Select => pattern!(
                    IUIAutomationSelectionItemPattern,
                    UIA_SelectionItemPatternId,
                    Select
                ),
                Action::Expand => pattern!(
                    IUIAutomationExpandCollapsePattern,
                    UIA_ExpandCollapsePatternId,
                    Expand
                ),
                Action::Collapse => pattern!(
                    IUIAutomationExpandCollapsePattern,
                    UIA_ExpandCollapsePatternId,
                    Collapse
                ),
                Action::ScrollIntoView => pattern!(
                    IUIAutomationScrollItemPattern,
                    UIA_ScrollItemPatternId,
                    ScrollIntoView
                ),
                Action::SetValue => {
                    let p = raw
                        .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                        .map_err(|_| Error::UnsupportedAction)?;
                    if p.CurrentIsReadOnly().map_err(mapped)?.as_bool() {
                        return Err(Error::UnsupportedAction);
                    }
                    let value = BSTR::from(value.ok_or(Error::InvalidArguments)?);
                    validate()?;
                    p.SetValue(&value).map_err(mapped)
                }
            }
        }
    }
}

#[allow(non_upper_case_globals)]
fn role(id: UIA_CONTROLTYPE_ID) -> Role {
    match id {
        UIA_WindowControlTypeId => Role::Window,
        UIA_ButtonControlTypeId | UIA_SplitButtonControlTypeId => Role::Button,
        UIA_CheckBoxControlTypeId => Role::CheckBox,
        UIA_RadioButtonControlTypeId => Role::RadioButton,
        UIA_EditControlTypeId => Role::TextField,
        UIA_TextControlTypeId => Role::Text,
        UIA_HyperlinkControlTypeId => Role::Link,
        UIA_ImageControlTypeId => Role::Image,
        UIA_ComboBoxControlTypeId => Role::ComboBox,
        UIA_ListControlTypeId => Role::List,
        UIA_ListItemControlTypeId => Role::ListItem,
        UIA_TreeControlTypeId => Role::Tree,
        UIA_TreeItemControlTypeId => Role::TreeItem,
        UIA_TabControlTypeId => Role::Tab,
        UIA_TabItemControlTypeId => Role::TabItem,
        UIA_MenuControlTypeId => Role::Menu,
        UIA_MenuItemControlTypeId => Role::MenuItem,
        UIA_MenuBarControlTypeId => Role::MenuBar,
        UIA_ToolBarControlTypeId => Role::ToolBar,
        UIA_SliderControlTypeId => Role::Slider,
        UIA_ProgressBarControlTypeId => Role::ProgressBar,
        UIA_ScrollBarControlTypeId => Role::ScrollBar,
        UIA_TableControlTypeId | UIA_DataGridControlTypeId => Role::Table,
        UIA_DataItemControlTypeId => Role::Row,
        UIA_HeaderControlTypeId => Role::Header,
        UIA_HeaderItemControlTypeId => Role::HeaderItem,
        UIA_DocumentControlTypeId => Role::Document,
        UIA_GroupControlTypeId => Role::Group,
        UIA_PaneControlTypeId => Role::Pane,
        UIA_SeparatorControlTypeId => Role::Separator,
        UIA_StatusBarControlTypeId => Role::StatusBar,
        UIA_SpinnerControlTypeId => Role::Spinner,
        _ => Role::Unknown,
    }
}
