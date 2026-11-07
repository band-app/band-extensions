//! Values of Band's editor protocol that need no browser: the layout and the selection an editor
//! reports. They live outside `bridge` so they can be unit tested natively.

use serde_json::{Value, json};

/// The most text of a selection sent to Band, in bytes.
pub const MAX_SELECTION_TEXT: usize = 4096;

/// Which interface Band wants. `Compact` is a phone-width layout or the iOS app.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Layout {
    #[default]
    Regular,
    Compact,
}

impl Layout {
    /// `None` for anything Band's protocol does not define, so an unknown value changes nothing.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "compact" => Some(Self::Compact),
            "regular" => Some(Self::Regular),
            _ => None,
        }
    }

    pub fn is_compact(self) -> bool {
        self == Self::Compact
    }
}

/// Band's theme: `mode` is `"light"` or `"dark"` (empty when Band sent none) and `tokens` are its
/// semantic colors by name, such as `background` and `foreground`, as CSS color strings.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Theme {
    pub mode: String,
    pub tokens: Vec<(String, String)>,
}

impl Theme {
    pub fn token(&self, name: &str) -> Option<&str> {
        self.tokens.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// A rectangle in the editor's own document units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// What the person has selected, addressed the way the editor's own MCP tools address it.
#[derive(Clone, Debug, PartialEq)]
pub struct Selection {
    /// The format's address: `Sheet1!B2:C4`, `slide2!<shape id>`, a node id, an element id.
    pub address: String,
    /// `cell`, `range`, `shape`, `text`, `paragraph`, `node`, `element` ...
    pub kind: String,
    /// Short text for a person: "Sheet1!B2:C4", "Title 1 on slide 2".
    pub label: String,
    /// The selected content as text. Capped at [`MAX_SELECTION_TEXT`] bytes when sent.
    pub text: Option<String>,
    pub rect: Option<Rect>,
}

impl Selection {
    pub fn new(address: impl Into<String>, kind: impl Into<String>, label: impl Into<String>) -> Self {
        Self { address: address.into(), kind: kind.into(), label: label.into(), text: None, rect: None }
    }

    pub fn with_text(mut self, text: impl Into<String>) -> Self {
        self.text = Some(text.into());
        self
    }

    pub fn with_rect(mut self, rect: Rect) -> Self {
        self.rect = Some(rect);
        self
    }

    /// The same selection with its text cut to the protocol's limit.
    pub fn capped(mut self) -> Self {
        self.text = self.text.map(|t| cap_text(&t));
        self
    }

    /// The `selection` field of the editor-to-Band message.
    pub fn to_json(&self) -> Value {
        let mut value = json!({"address": self.address, "kind": self.kind, "label": self.label});
        if let Some(text) = &self.text {
            value["text"] = json!(cap_text(text));
        }
        if let Some(r) = self.rect {
            value["rect"] = json!({"x": r.x, "y": r.y, "width": r.width, "height": r.height});
        }
        value
    }
}

/// `text`, or its first bytes up to a character boundary followed by "…" when it is longer than
/// [`MAX_SELECTION_TEXT`] bytes. The result, ellipsis included, is within the limit.
pub fn cap_text(text: &str) -> String {
    const ELLIPSIS: &str = "…";
    if text.len() <= MAX_SELECTION_TEXT {
        return text.to_string();
    }
    let mut end = MAX_SELECTION_TEXT - ELLIPSIS.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{ELLIPSIS}", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_parses_only_known_values() {
        assert_eq!(Layout::parse("compact"), Some(Layout::Compact));
        assert_eq!(Layout::parse("regular"), Some(Layout::Regular));
        assert_eq!(Layout::parse("tablet"), None);
    }

    #[test]
    fn short_text_is_kept() {
        assert_eq!(cap_text("a\tb\nc\td"), "a\tb\nc\td");
    }

    #[test]
    fn long_text_is_cut_to_the_limit_on_a_character_boundary() {
        let long = "é".repeat(5000);
        let capped = cap_text(&long);
        assert!(capped.len() <= MAX_SELECTION_TEXT);
        assert!(capped.ends_with('…'));
        assert!(capped.is_char_boundary(capped.len()));
    }

    #[test]
    fn json_has_the_contract_fields() {
        let s = Selection::new("Sheet1!B2:C4", "range", "Sheet1!B2:C4").with_text("1\t2").with_rect(Rect { x: 1.0, y: 2.0, width: 3.0, height: 4.0 });
        let v = s.to_json();
        assert_eq!(v["address"], "Sheet1!B2:C4");
        assert_eq!(v["kind"], "range");
        assert_eq!(v["label"], "Sheet1!B2:C4");
        assert_eq!(v["text"], "1\t2");
        assert_eq!(v["rect"]["width"], 3.0);
        assert!(Selection::new("a", "cell", "a").to_json().get("text").is_none());
    }
}
