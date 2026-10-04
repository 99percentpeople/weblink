//! Inspect capabilities only: never read text, values, labels or passwords.
use super::Focus;
use windows::{
    core::Interface,
    Win32::{
        System::{
            Com::*,
            Variant::{VariantToBoolean, VT_BOOL},
        },
        UI::{Accessibility::*, WindowsAndMessaging::GetForegroundWindow},
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
pub(super) struct Detector {
    // Release every COM reference before uninitializing the apartment.
    automation: IUIAutomation,
    previous: Option<IUIAutomationElement>,
    focus_id: String,
    _apartment: Apartment,
}
impl Detector {
    pub(super) fn new() -> Option<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok()?;
            let apartment = Apartment;
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER).ok()?;
            let options: IUIAutomation2 = automation.cast().ok()?;
            options.SetConnectionTimeout(150).ok()?;
            options.SetTransactionTimeout(150).ok()?;
            Some(Self {
                automation,
                previous: None,
                focus_id: String::new(),
                _apartment: apartment,
            })
        }
    }
    pub(super) fn focus(&mut self) -> Focus {
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.0.is_null() {
                return Focus::Unknown;
            }
            let Ok((editable, element)) = self.inspect() else {
                return Focus::Unknown;
            };
            if GetForegroundWindow() != foreground {
                return Focus::Unknown;
            }
            if !editable {
                self.previous = None;
                return Focus::None;
            }
            // Native element identities remain local; transmit an opaque focus ID.
            if let Some(previous) = &self.previous {
                match self.automation.CompareElements(previous, &element) {
                    Ok(same) if same.as_bool() => {
                        return Focus::Editable {
                            id: self.focus_id.clone(),
                        }
                    }
                    _ => (),
                }
            }
            self.focus_id = uuid::Uuid::new_v4().to_string();
            self.previous = Some(element);
            Focus::Editable {
                id: self.focus_id.clone(),
            }
        }
    }
    unsafe fn inspect(&self) -> windows::core::Result<(bool, IUIAutomationElement)> {
        let element = self.automation.GetFocusedElement()?;
        if !element.CurrentHasKeyboardFocus()?.as_bool() {
            return Err(unknown());
        }
        if !element.CurrentIsEnabled()?.as_bool() {
            return Ok((false, element));
        }
        // Standard edits, password fields and editable combo boxes.
        let value_available = property(&element, UIA_IsValuePatternAvailablePropertyId)?;
        if value_available {
            let value =
                element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)?;
            if !value.CurrentIsReadOnly()?.as_bool() {
                return Ok((true, element));
            }
        }
        if !property(&element, UIA_IsTextPatternAvailablePropertyId)? {
            let kind = element.CurrentControlType()?;
            if !value_available
                && [
                    UIA_EditControlTypeId,
                    UIA_DocumentControlTypeId,
                    UIA_CustomControlTypeId,
                ]
                .contains(&kind)
            {
                return Err(unknown());
            }
            return Ok((false, element));
        }
        // Rich editors/contenteditable may expose Text without a writable Value.
        let text = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)?;
        let attribute = text
            .DocumentRange()?
            .GetAttributeValue(UIA_IsReadOnlyAttributeId)?;
        // Mixed/unsupported attributes are not evidence of an editable field.
        if attribute.Anonymous.Anonymous.vt != VT_BOOL {
            return Err(unknown());
        }
        Ok((!VariantToBoolean(&attribute)?.as_bool(), element))
    }
}

fn unknown() -> windows::core::Error {
    windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
}
unsafe fn property(
    element: &IUIAutomationElement,
    id: UIA_PROPERTY_ID,
) -> windows::core::Result<bool> {
    let value = element.GetCurrentPropertyValue(id)?;
    if value.Anonymous.Anonymous.vt != VT_BOOL {
        return Err(unknown());
    }
    Ok(VariantToBoolean(&value)?.as_bool())
}
