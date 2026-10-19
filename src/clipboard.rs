use arboard::Clipboard;
use std::sync::Mutex;

pub struct ClipboardManager {
    inner: Mutex<Option<Clipboard>>,
}

impl ClipboardManager {
    pub fn new() -> Self {
        let cb = Clipboard::new().ok();
        Self {
            inner: Mutex::new(cb),
        }
    }

    pub fn get_text(&self) -> Option<String> {
        let mut guard = self.inner.lock().ok()?;
        if let Some(cb) = guard.as_mut() {
            cb.get_text().ok()
        } else {
            None
        }
    }

    pub fn set_text(&self, text: &str) -> bool {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(cb) = guard.as_mut() {
                return cb.set_text(text).is_ok();
            }
        }
        false
    }
}
