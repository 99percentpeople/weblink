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
}
impl ElementInfo {
    #[cfg(any(windows, test))]
    pub(crate) fn redact(&mut self) {
        // A protected control's provider may incorrectly expose its value as its name.
        if self.protected {
            self.name.clear();
            self.automation_id.clear();
            self.actions.clear();
        }
        self.name = self.name.chars().take(512).collect();
        self.automation_id = self.automation_id.chars().take(256).collect();
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
    },
    Action {
        element_id: String,
        action: Action,
        value: Option<String>,
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
            } => {
                !element_id.is_empty()
                    && (1..=8).contains(max_depth)
                    && (1..=256).contains(max_nodes)
            }
            Self::Action {
                element_id,
                action,
                value,
            } => {
                !element_id.is_empty()
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
