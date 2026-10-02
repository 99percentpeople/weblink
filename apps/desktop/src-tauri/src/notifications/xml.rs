use super::Notification;
fn escape(text: &str) -> String {
    text.chars()
        .filter(|c| {
            matches!(*c, '\t' | '\n' | '\r') || (*c >= ' ' && *c != '\u{fffe}' && *c != '\u{ffff}')
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub fn toast(notification: &Notification, icon: Option<&str>) -> String {
    let mut xml = format!("<toast launch=\"open\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text>", escape(&notification.title), escape(&notification.body));
    if let Some(icon) = icon {
        xml.push_str(&format!(
            "<image placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"{}\"/>",
            escape(icon)
        ));
    }
    xml.push_str("</binding></visual>");
    if !notification.actions.is_empty() || notification.reply.is_some() {
        xml.push_str("<actions>");
        if let Some(reply) = &notification.reply {
            xml.push_str(&format!("<input id=\"reply\" type=\"text\" placeHolderContent=\"{}\"/><action content=\"{}\" arguments=\"reply\" activationType=\"foreground\" hint-inputId=\"reply\"/>", escape(&reply.placeholder), escape(&reply.title)));
        }
        for action in &notification.actions {
            xml.push_str(&format!(
                "<action content=\"{}\" arguments=\"{}\" activationType=\"foreground\"/>",
                escape(&action.title),
                escape(&action.id)
            ));
        }
        xml.push_str("</actions>");
    }
    if notification.silent {
        xml.push_str("<audio silent=\"true\"/>");
    }
    xml.push_str("</toast>");
    xml
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escapes_peer_content_and_keeps_fixed_actions() {
        let mut n = crate::notifications::tests::notice();
        n.body = "<action content=\"evil\">&\u{0001}".into();
        let xml = toast(&n, Some("file:///avatar&test.png"));
        assert!(xml.contains("&lt;action content=&quot;evil&quot;&gt;&amp;"));
        assert!(!xml.contains('\u{0001}'));
        assert!(xml.contains("arguments=\"approve\""));
        assert!(xml.contains("<audio silent=\"true\"/>"));
        assert!(xml.contains("placement=\"appLogoOverride\" hint-crop=\"circle\" src=\"file:///avatar&amp;test.png\""));
        assert!(!toast(&n, None).contains("<image"));
    }
}
