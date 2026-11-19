use std::collections::VecDeque;

#[derive(Default)]
pub struct Echoes(VecDeque<(String, Vec<String>)>);
impl Echoes {
    pub fn note(&mut self, text: &str, ids: &[String]) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let ids: Vec<_> = ids.iter().filter(|id| !id.is_empty()).cloned().collect();
        self.0.retain(|(_, old)| {
            if ids.is_empty() {
                !old.is_empty()
            } else {
                !old.iter().any(|id| ids.contains(id))
            }
        });
        if self.0.iter().any(|(t, _)| t == text) {
            return;
        }
        self.0.push_back((text.into(), ids));
        if self.0.len() > 32 {
            self.0.pop_front();
        }
    }
    pub fn discard_id(&mut self, id: &str) {
        self.0.retain(|(_, ids)| !ids.iter().any(|s| s == id));
    }
    pub fn discard_text(&mut self, text: &str) {
        self.consume(text);
    }
    pub(super) fn consume(&mut self, text: &str) -> bool {
        if let Some(i) = self.0.iter().position(|(t, _)| t == text.trim()) {
            self.0.remove(i);
            true
        } else {
            false
        }
    }
}
