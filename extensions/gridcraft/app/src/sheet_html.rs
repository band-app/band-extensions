//! The compact preview's table: one sheet as HTML, built from the engine's own values and styles.
//!
//! The text of a cell is what GridCraft shows (`display::cell_text`, so number formats, dates and
//! currencies match the editor). Styles are interned into CSS classes, one per engine style, so a
//! sheet with thousands of cells repeats a class name and not a declaration. No script, image or
//! link is emitted, and every string from the document is escaped.

use std::collections::HashMap;
use std::fmt::Write as _;

use gridcraft_engine::core::{CellRef, RangeRef, Value, col_to_letters};
use gridcraft_engine::display;
use gridcraft_engine::model::style::{BorderLine, BorderStyle, HAlign, PatternType, Style, StyleId, Underline, VAlign};
use gridcraft_engine::model::{Sheet, Workbook};

/// Most columns drawn. Wider sheets are cut here and the preview says so.
pub const MAX_COLS: u32 = 200;
/// Rows drawn in the first page, and the size of each further page.
pub const PAGE_ROWS: u32 = 400;

/// Width of the row-number column in CSS pixels.
const ROW_LABEL_PX: u32 = 44;

/// A sheet ready for the page.
pub struct Rendered {
    /// `<style>` and `<table>`.
    pub html: String,
    /// More rows exist below the last one drawn.
    pub more: bool,
    /// Columns past [`MAX_COLS`] were left out.
    pub cut_cols: bool,
}

/// Sheet names, in order, with hidden sheets left out. The second value is the index of `active`
/// among the returned names (or 0).
pub fn sheet_names(wb: &Workbook) -> (Vec<(usize, String)>, usize) {
    let names: Vec<(usize, String)> = wb
        .sheets
        .iter()
        .enumerate()
        .filter(|(i, s)| *i == wb.active_sheet || s.visibility == gridcraft_engine::model::Visibility::Visible)
        .map(|(i, s)| (i, s.name.clone()))
        .collect();
    let pos = names.iter().position(|(i, _)| *i == wb.active_sheet).unwrap_or(0);
    (names, pos)
}

/// Draw sheet `index` with rows `0..rows` (clipped to the used range).
pub fn render(wb: &Workbook, index: usize, rows: u32) -> Rendered {
    let Some(sheet) = wb.sheet(index) else { return Rendered { html: String::new(), more: false, cut_cols: false } };
    let used = sheet.used_range();
    // A merged range can reach past the last filled cell.
    let last_row = sheet.merges.iter().map(|m| m.end.row).chain(used.map(|r| r.end.row)).max().unwrap_or(0);
    let last_col = sheet.merges.iter().map(|m| m.end.col).chain(used.map(|r| r.end.col)).max().unwrap_or(0);
    // An empty sheet still draws a screenful of empty cells, so the headings show.
    let (last_row, last_col) = if used.is_some() || !sheet.merges.is_empty() { (last_row, last_col) } else { (29, 9) };
    let end_row = last_row.min(rows.saturating_sub(1));
    let cut_cols = last_col >= MAX_COLS;
    let end_col = last_col.min(MAX_COLS - 1);
    let window = RangeRef { start: CellRef::new(0, 0), end: CellRef::new(end_row, end_col) };

    let cols: Vec<u32> = (0..=end_col).filter(|c| !sheet.is_col_hidden(*c)).collect();
    let row_list: Vec<u32> = (0..=end_row).filter(|r| !sheet.is_row_hidden(*r)).collect();

    // Merges: the top-left cell carries the span, the others are skipped.
    let mut spans: HashMap<(u32, u32), (usize, usize)> = HashMap::new();
    let mut covered: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    for m in &sheet.merges {
        let (r0, r1) = (m.start.row, m.end.row.min(end_row));
        let (c0, c1) = (m.start.col, m.end.col.min(end_col));
        if r0 > end_row || c0 > end_col {
            continue;
        }
        let colspan = cols.iter().filter(|c| (c0..=c1).contains(c)).count();
        let rowspan = row_list.iter().filter(|r| (r0..=r1).contains(r)).count();
        spans.insert((r0, c0), (colspan.max(1), rowspan.max(1)));
        for r in r0..=r1 {
            for c in c0..=c1 {
                if (r, c) != (r0, c0) && window.contains(CellRef::new(r, c)) {
                    covered.insert((r, c));
                }
            }
        }
    }

    let mut classes = Classes::new(wb, sheet);
    let mut body = String::new();
    let widths: Vec<u32> = cols.iter().map(|c| px(sheet.col_width(*c))).collect();
    let _ = write!(
        body,
        "<table class=\"gc-t\" style=\"width:{}px\"><colgroup><col style=\"width:{ROW_LABEL_PX}px\">",
        ROW_LABEL_PX + widths.iter().sum::<u32>()
    );
    for w in &widths {
        let _ = write!(body, "<col style=\"width:{w}px\">");
    }
    body.push_str("</colgroup><thead><tr><th class=\"gc-corner\"></th>");
    for c in &cols {
        let _ = write!(body, "<th>{}</th>", col_to_letters(*c));
    }
    body.push_str("</tr></thead><tbody>");
    for r in &row_list {
        let default_h = sheet.default_row_height;
        let h = sheet.row_height(*r);
        if (h - default_h).abs() > 0.5 {
            let _ = write!(body, "<tr data-r=\"{r}\" style=\"height:{}px\">", px(h));
        } else {
            let _ = write!(body, "<tr data-r=\"{r}\">");
        }
        let _ = write!(body, "<th>{}</th>", r + 1);
        for c in &cols {
            if covered.contains(&(*r, *c)) {
                continue;
            }
            write_cell(&mut body, wb, sheet, CellRef::new(*r, *c), spans.get(&(*r, *c)).copied(), &mut classes);
        }
        body.push_str("</tr>");
    }
    body.push_str("</tbody></table>");

    let mut html = String::with_capacity(body.len() + 1024);
    html.push_str("<style>");
    html.push_str(&classes.css());
    html.push_str("</style>");
    html.push_str(&body);
    Rendered { html, more: last_row > end_row, cut_cols }
}

/// One `<td>`.
fn write_cell(out: &mut String, wb: &Workbook, sheet: &Sheet, at: CellRef, span: Option<(usize, usize)>, classes: &mut Classes) {
    let style_id = sheet.style_id(at);
    let class = classes.get(style_id);
    let value = sheet.value(at);
    let text = display::cell_text(wb, sheet, at);
    // General alignment: numbers right, text left, booleans and errors centred.
    let auto = match value {
        Value::Number(_) => " gc-n",
        Value::Bool(_) | Value::Error(_) => " gc-c",
        _ => "",
    };
    let _ = write!(out, "<td data-c=\"{}\" class=\"s{class}{auto}\"", at.col);
    if let Some((cs, rs)) = span {
        if cs > 1 {
            let _ = write!(out, " colspan=\"{cs}\"");
        }
        if rs > 1 {
            let _ = write!(out, " rowspan=\"{rs}\"");
        }
    }
    if let Some(formula) = sheet.cell(at).and_then(|c| c.formula.as_ref())
        && !display::formula_hidden(wb, sheet, at)
    {
        out.push_str(" data-f=\"=");
        escape_into(out, &formula.text);
        out.push('"');
    }
    out.push('>');
    escape_into(out, &text);
    out.push_str("</td>");
}

/// Engine styles used by the sheet, as numbered CSS classes.
struct Classes<'a> {
    wb: &'a Workbook,
    sheet: &'a Sheet,
    ids: HashMap<StyleId, usize>,
    rules: Vec<String>,
}

impl<'a> Classes<'a> {
    fn new(wb: &'a Workbook, sheet: &'a Sheet) -> Self {
        Self { wb, sheet, ids: HashMap::new(), rules: Vec::new() }
    }

    fn get(&mut self, id: StyleId) -> usize {
        if let Some(n) = self.ids.get(&id) {
            return *n;
        }
        let n = self.rules.len();
        self.rules.push(style_css(self.wb, self.sheet, self.wb.styles.get(id), n));
        self.ids.insert(id, n);
        n
    }

    fn css(&self) -> String {
        self.rules.concat()
    }
}

fn style_css(wb: &Workbook, sheet: &Sheet, style: &Style, n: usize) -> String {
    let mut css = String::new();
    let font = &style.font;
    if font.bold {
        css.push_str("font-weight:700;");
    }
    if font.italic {
        css.push_str("font-style:italic;");
    }
    let mut deco = Vec::new();
    if !matches!(font.underline, Underline::None) {
        deco.push("underline");
    }
    if font.strike {
        deco.push("line-through");
    }
    if !deco.is_empty() {
        let _ = write!(css, "text-decoration:{};", deco.join(" "));
    }
    if font.size > 0.0 && (font.size - 11.0).abs() > 0.1 {
        let _ = write!(css, "font-size:{:.1}px;", font.size.clamp(6.0, 72.0) * 96.0 / 72.0);
    }
    if let Some(rgb) = font.color.resolve(&wb.theme) {
        let _ = write!(css, "color:{};", hex(rgb));
    }
    if matches!(style.fill.pattern, PatternType::Solid)
        && let Some(rgb) = style.fill.fg.resolve(&wb.theme)
    {
        let _ = write!(css, "background:{};", hex(rgb));
    }
    match style.align.h {
        HAlign::Left | HAlign::Justify | HAlign::Fill | HAlign::Distributed => css.push_str("text-align:left;"),
        HAlign::Center | HAlign::CenterAcross => css.push_str("text-align:center;"),
        HAlign::Right => css.push_str("text-align:right;"),
        HAlign::General => {}
    }
    match style.align.v {
        VAlign::Top => css.push_str("vertical-align:top;"),
        VAlign::Center => css.push_str("vertical-align:middle;"),
        _ => {}
    }
    if style.align.wrap {
        css.push_str("white-space:pre-wrap;overflow-wrap:anywhere;");
    }
    if style.align.indent > 0 {
        let _ = write!(css, "padding-left:{}px;", 6 + u32::from(style.align.indent) * 9);
    }
    for (side, line) in [("left", style.borders.left), ("right", style.borders.right), ("top", style.borders.top), ("bottom", style.borders.bottom)] {
        if let Some(b) = border_css(wb, line) {
            let _ = write!(css, "border-{side}:{b};");
        }
    }
    if !sheet.show_gridlines {
        // The default rule draws gridlines; this cell class turns them off unless it sets a border.
        css.push_str("--gl:transparent;");
    }
    format!(".s{n}{{{css}}}")
}

fn border_css(wb: &Workbook, line: BorderLine) -> Option<String> {
    let kind = match line.style {
        BorderStyle::None => return None,
        BorderStyle::Dashed
        | BorderStyle::MediumDashed
        | BorderStyle::DashDot
        | BorderStyle::MediumDashDot
        | BorderStyle::DashDotDot
        | BorderStyle::MediumDashDotDot
        | BorderStyle::SlantDashDot => "dashed",
        BorderStyle::Dotted | BorderStyle::Hair => "dotted",
        BorderStyle::Double => "double",
        _ => "solid",
    };
    let color = line.color.resolve(&wb.theme).map_or_else(|| "#000".to_string(), hex);
    Some(format!("{}px {kind} {color}", line.style.width().max(1.0)))
}

fn hex(rgb: [u8; 3]) -> String {
    format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
}

/// Points to CSS pixels.
fn px(points: f32) -> u32 {
    (points * 96.0 / 72.0).round().max(1.0) as u32
}

fn escape_into(out: &mut String, text: &str) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;
    use gridcraft_engine::model::style::Color;
    use gridcraft_engine::model::{Cell, Formula};

    fn text_cell(wb: &mut Workbook, at: &str, text: &str) {
        let at = CellRef::parse(at).expect("address");
        wb.sheet_mut(0).expect("sheet").set_value(at, Value::text(text));
    }

    fn number_cell(wb: &mut Workbook, at: &str, n: f64) {
        let at = CellRef::parse(at).expect("address");
        wb.sheet_mut(0).expect("sheet").set_value(at, Value::Number(n));
    }

    #[test]
    fn shows_values_formulas_and_escapes_text() {
        let mut wb = Workbook::new();
        number_cell(&mut wb, "A1", 1234.5);
        let at = CellRef::parse("A2").expect("address");
        wb.sheet_mut(0)
            .expect("sheet")
            .set_cell(at, Cell { value: Value::Number(2469.0), formula: Some(std::sync::Arc::new(Formula::new("=A1*2"))), style: StyleId::DEFAULT });
        text_cell(&mut wb, "B1", "<b>x</b> & y");
        let html = render(&wb, 0, 10).html;
        assert!(html.contains("1234.5"), "{html}");
        assert!(html.contains("2469"), "{html}");
        assert!(html.contains("data-f=\"=A1*2\""), "{html}");
        assert!(html.contains("&lt;b&gt;x&lt;/b&gt; &amp; y"), "{html}");
        assert!(!html.contains("<b>x"), "{html}");
    }

    #[test]
    fn rows_come_in_pages() {
        let mut wb = Workbook::new();
        text_cell(&mut wb, "A50", "end");
        let first = render(&wb, 0, 10);
        assert!(first.more);
        assert!(!first.html.contains(">end<"));
        let all = render(&wb, 0, 100);
        assert!(!all.more);
        assert!(all.html.contains(">end<"));
    }

    #[test]
    fn merged_cells_span_and_hide_the_rest() {
        let mut wb = Workbook::new();
        text_cell(&mut wb, "A1", "title");
        text_cell(&mut wb, "B1", "hidden");
        let range = RangeRef { start: CellRef::new(0, 0), end: CellRef::new(1, 2) };
        wb.sheet_mut(0).expect("sheet").merges.push(range);
        let html = render(&wb, 0, 10).html;
        assert!(html.contains("colspan=\"3\""), "{html}");
        assert!(html.contains("rowspan=\"2\""), "{html}");
        assert!(!html.contains("hidden"), "{html}");
    }

    #[test]
    fn bold_fill_and_border_become_css() {
        let mut wb = Workbook::new();
        text_cell(&mut wb, "A1", "head");
        let at = CellRef::new(0, 0);
        let base = wb.sheet(0).expect("sheet").style_id(at);
        let id = wb.styles.derive(base, |s| {
            s.font.bold = true;
            s.fill = gridcraft_engine::model::style::Fill::solid(Color::rgb(255, 0, 0));
            s.borders.bottom = BorderLine::thin();
        });
        wb.sheet_mut(0).expect("sheet").set_style(at, id);
        let html = render(&wb, 0, 10).html;
        assert!(html.contains("font-weight:700"), "{html}");
        assert!(html.contains("background:#ff0000"), "{html}");
        assert!(html.contains("border-bottom:1px solid #000"), "{html}");
    }

    #[test]
    fn hidden_columns_are_left_out() {
        let mut wb = Workbook::new();
        text_cell(&mut wb, "A1", "a");
        text_cell(&mut wb, "B1", "b");
        text_cell(&mut wb, "C1", "c");
        wb.sheet_mut(0).expect("sheet").cols.entry(1).or_default().hidden = true;
        let html = render(&wb, 0, 10).html;
        assert!(html.contains(">a<") && html.contains(">c<") && !html.contains(">b<"), "{html}");
    }
}
