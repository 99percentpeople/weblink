use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Unsupported,
    UnsupportedAction,
    InvalidArguments,
    StaleElement,
    PermissionDenied,
    ControlRequired,
    ApprovalPending,
    ProtectedElement,
    ElementDisabled,
    Busy,
    Cancelled,
    Timeout,
    ProviderUnavailable,
}
impl Error {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unsupported => "UNSUPPORTED",
            Self::UnsupportedAction => "UNSUPPORTED_ACTION",
            Self::InvalidArguments => "INVALID_ARGUMENTS",
            Self::StaleElement => "STALE_ELEMENT",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::ControlRequired => "CONTROL_REQUIRED",
            Self::ApprovalPending => "APPROVAL_PENDING",
            Self::ProtectedElement => "PROTECTED_ELEMENT",
            Self::ElementDisabled => "ELEMENT_DISABLED",
            Self::Busy => "BUSY",
            Self::Cancelled => "CANCELLED",
            Self::Timeout => "TIMEOUT",
            Self::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    Focus,
    Invoke,
    SetValue,
    Toggle,
    Select,
    Expand,
    Collapse,
    ScrollIntoView,
}
pub const ACTIONS: [Action; 8] = [
    Action::Focus,
    Action::Invoke,
    Action::SetValue,
    Action::Toggle,
    Action::Select,
    Action::Expand,
    Action::Collapse,
    Action::ScrollIntoView,
];

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Window,
    Button,
    CheckBox,
    RadioButton,
    TextField,
    Text,
    Link,
    Image,
    ComboBox,
    List,
    ListItem,
    Tree,
    TreeItem,
    Tab,
    TabItem,
    Menu,
    MenuItem,
    MenuBar,
    ToolBar,
    Slider,
    ProgressBar,
    ScrollBar,
    Table,
    Row,
    Header,
    HeaderItem,
    Document,
    Group,
    Pane,
    Separator,
    StatusBar,
    Spinner,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
pub struct Bounds {
    /// Physical desktop coordinates; these are not normalized capture coordinates.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementInfo {
    pub role: Role,
    pub name: String,
    pub automation_id: String,
    pub process_id: u32,
    pub bounds: Bounds,
    pub enabled: bool,
    pub focused: bool,
    pub offscreen: bool,
    pub protected: bool,
    pub actions: Vec<Action>,
    #[serde(flatten)]
    pub state: ElementState,
}
impl ElementInfo {
    #[cfg(any(windows, test))]
    pub(crate) fn redact(&mut self) {
        // A protected control's provider may incorrectly expose its value as its name.
        if self.protected {
            self.name.clear();
            self.automation_id.clear();
            self.actions.clear();
            self.state = ElementState::default();
        }
        if !self.protected && self.name.chars().count() > 512 {
            self.state.name_truncated = Some(true);
        }
        self.name = self.name.chars().take(512).collect();
        self.automation_id = self.automation_id.chars().take(256).collect();
    }

    #[cfg(any(windows, test))]
    pub(crate) fn sanitize(&mut self, options: &ReadOptions) {
        self.redact();
        if !options.include_values {
            self.state.value = None;
            self.state.text = None;
            self.state.value_truncated = None;
            self.state.text_truncated = None;
        }
        for (content, truncated) in [
            (&mut self.state.value, &mut self.state.value_truncated),
            (&mut self.state.text, &mut self.state.text_truncated),
        ] {
            if let Some(content) = content {
                let was_truncated = content.chars().count() > options.max_text_length;
                *content = content.chars().take(options.max_text_length).collect();
                *truncated = Some(truncated.unwrap_or(false) || was_truncated);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToggleState {
    On,
    Off,
    Indeterminate,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExpandCollapseState {
    Collapsed,
    Expanded,
    PartiallyExpanded,
    LeafNode,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub toggle_state: Option<ToggleState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expand_collapse_state: Option<ExpandCollapseState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_truncated: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadOptions {
    pub include_values: bool,
    pub max_text_length: usize,
}
impl Default for ReadOptions {
    fn default() -> Self {
        Self {
            include_values: false,
            max_text_length: 1024,
        }
    }
}
impl ReadOptions {
    pub fn validate(&self) -> Result<()> {
        if (1..=4096).contains(&self.max_text_length) {
            Ok(())
        } else {
            Err(Error::InvalidArguments)
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Observation {
    pub element_id: Option<String>,
    pub max_depth: usize,
    pub max_nodes: usize,
    pub include_values: bool,
    pub max_text_length: usize,
}
impl Default for Observation {
    fn default() -> Self {
        Self {
            element_id: None,
            max_depth: 2,
            max_nodes: 64,
            include_values: false,
            max_text_length: 1024,
        }
    }
}
impl Observation {
    pub fn read_options(&self) -> ReadOptions {
        ReadOptions {
            include_values: self.include_values,
            max_text_length: self.max_text_length,
        }
    }
    pub fn validate(&self) -> Result<()> {
        self.read_options().validate()?;
        if self
            .element_id
            .as_ref()
            .is_none_or(|id| !id.is_empty() && id.len() <= 128)
            && (1..=8).contains(&self.max_depth)
            && (1..=256).contains(&self.max_nodes)
        {
            Ok(())
        } else {
            Err(Error::InvalidArguments)
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WaitCondition {
    pub enabled: Option<bool>,
    pub focused: Option<bool>,
    pub offscreen: Option<bool>,
    pub selected: Option<bool>,
    pub toggle_state: Option<ToggleState>,
    pub expand_collapse_state: Option<ExpandCollapseState>,
    pub value: Option<String>,
    pub text_contains: Option<String>,
    pub name: Option<String>,
}
impl WaitCondition {
    pub fn validate(&self) -> Result<()> {
        let nonempty = self.enabled.is_some()
            || self.focused.is_some()
            || self.offscreen.is_some()
            || self.selected.is_some()
            || self.toggle_state.is_some()
            || self.expand_collapse_state.is_some()
            || self.value.is_some()
            || self.text_contains.is_some()
            || self.name.is_some();
        if nonempty
            && [&self.value, &self.text_contains]
                .into_iter()
                .all(|v| v.as_ref().is_none_or(|v| v.chars().count() <= 4096))
            && self.name.as_ref().is_none_or(|v| v.chars().count() <= 512)
        {
            Ok(())
        } else {
            Err(Error::InvalidArguments)
        }
    }
    pub(crate) fn matches(&self, node: &serde_json::Value) -> bool {
        !node["protected"].as_bool().unwrap_or(true)
            && self.enabled.is_none_or(|v| node["enabled"] == v)
            && self.focused.is_none_or(|v| node["focused"] == v)
            && self.offscreen.is_none_or(|v| node["offscreen"] == v)
            && self.selected.is_none_or(|v| node["selected"] == v)
            && self
                .toggle_state
                .is_none_or(|v| node["toggleState"] == serde_json::to_value(v).unwrap())
            && self
                .expand_collapse_state
                .is_none_or(|v| node["expandCollapseState"] == serde_json::to_value(v).unwrap())
            && self.value.as_ref().is_none_or(|v| {
                node["valueTruncated"] != true && node["value"].as_str() == Some(v.as_str())
            })
            && self
                .text_contains
                .as_ref()
                .is_none_or(|v| node["text"].as_str().is_some_and(|text| text.contains(v)))
            && self.name.as_ref().is_none_or(|v| {
                node["nameTruncated"] != true && node["name"].as_str() == Some(v.as_str())
            })
    }
    pub(crate) fn read_options(&self) -> ReadOptions {
        ReadOptions {
            include_values: self.value.is_some() || self.text_contains.is_some(),
            max_text_length: 4096,
        }
    }
}

#[derive(Clone, Debug)]
pub struct WaitRequest {
    pub element_id: String,
    pub condition: WaitCondition,
    pub timeout_ms: u64,
    pub poll_interval_ms: u64,
}
impl WaitRequest {
    pub fn validate(&self) -> Result<()> {
        self.condition.validate()?;
        if !self.element_id.is_empty()
            && self.element_id.len() <= 128
            && (1..=30000).contains(&self.timeout_ms)
            && (50..=1000).contains(&self.poll_interval_ms)
        {
            Ok(())
        } else {
            Err(Error::InvalidArguments)
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub element_id: String,
    pub parent_id: Option<String>,
    pub depth: usize,
    #[serde(flatten)]
    pub info: ElementInfo,
}

#[derive(Clone, Debug)]
pub enum Request {
    Capabilities,
    Windows {
        limit: usize,
    },
    Snapshot {
        element_id: String,
        max_depth: usize,
        max_nodes: usize,
        options: ReadOptions,
    },
    /// A single inspection used by wait; keeps the original native identity.
    Inspect {
        element_id: String,
        options: ReadOptions,
        /// Create a fresh reference only when this predicate matches this same inspection.
        /// Unmatched polling (or None) does not allocate references or refresh their TTL.
        refresh_when: Option<WaitCondition>,
    },
    Wait(WaitRequest),
    Action {
        element_id: String,
        action: Action,
        value: Option<String>,
        observe_after: Option<Observation>,
    },
}
impl Request {
    pub(crate) fn validate(&self) -> Result<()> {
        let valid = match self {
            Self::Capabilities => true,
            Self::Windows { limit } => (1..=128).contains(limit),
            Self::Snapshot {
                element_id,
                max_depth,
                max_nodes,
                options,
            } => {
                !element_id.is_empty()
                    && (1..=8).contains(max_depth)
                    && (1..=256).contains(max_nodes)
                    && options.validate().is_ok()
            }
            Self::Inspect {
                element_id,
                options,
                refresh_when,
            } => {
                !element_id.is_empty()
                    && options.validate().is_ok()
                    && refresh_when
                        .as_ref()
                        .is_none_or(|condition| condition.validate().is_ok())
            }
            Self::Wait(wait) => return wait.validate(),
            Self::Action {
                element_id,
                action,
                value,
                observe_after,
            } => {
                !element_id.is_empty()
                    && observe_after.as_ref().is_none_or(|v| v.validate().is_ok())
                    && if *action == Action::SetValue {
                        value.as_ref().is_some_and(|v| v.chars().count() <= 4096)
                    } else {
                        value.is_none()
                    }
            }
        };
        if valid {
            Ok(())
        } else {
            Err(Error::InvalidArguments)
        }
    }
}
