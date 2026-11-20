use super::manager::RpcHandlerManager;
use serde_json::{json, Value};
use std::{
    io,
    path::{Component, Path, PathBuf},
};
pub mod files;
pub use files::GeneratedImages;

fn error(s: impl ToString) -> Value {
    json!({"success":false,"error":s.to_string()})
}
fn field<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
fn normalize(input: &Path) -> PathBuf {
    let mut path = PathBuf::new();
    for c in input.components() {
        match c {
            Component::ParentDir => {
                path.pop();
            }
            Component::CurDir => {}
            _ => path.push(c.as_os_str()),
        }
    }
    path
}
fn lexical(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let root = normalize(&std::path::absolute(root).map_err(|e| e.to_string())?);
    let path = normalize(&root.join(raw));
    if path.starts_with(&root) {
        Ok(path)
    } else {
        Err(format!(
            "Access denied: Path '{raw}' is outside the working directory"
        ))
    }
}
fn fs_error(e: io::Error, op: &str, p: &Path) -> String {
    let Some(code) = e.raw_os_error() else {
        return e.to_string();
    };
    let errno = nix::errno::Errno::from_raw(code);
    let msg = e.to_string();
    format!(
        "{errno:?}: {}, {op} '{}'",
        msg.split(" (os error")
            .next()
            .unwrap_or(&msg)
            .to_lowercase(),
        p.display()
    )
}
fn canonical(root: &Path, p: &Path) -> Result<PathBuf, String> {
    let resolved = p.canonicalize().map_err(|e| fs_error(e, "realpath", p))?;
    check_resolved(root, resolved)
}
fn check_resolved(root: &Path, resolved: PathBuf) -> Result<PathBuf, String> {
    if resolved.starts_with(
        lexical(root, "")?
            .canonicalize()
            .map_err(|e| fs_error(e, "realpath", root))?,
    ) {
        Ok(resolved)
    } else {
        Err("Access denied: resolved path is outside the working directory".into())
    }
}
/// English localeCompare weights for printable ASCII: punctuation, digits and
/// folded letters first, then lowercase before uppercase. Other code points
/// retain their scalar order, after printable ASCII.
fn compare_names(a: &str, b: &str) -> std::cmp::Ordering {
    const ORDER: &str =
        r##" _-,;:!?.'"()[]{}@*/\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz"##;
    fn weight(c: char) -> u32 {
        ORDER
            .find(c.to_ascii_lowercase())
            .map_or(128 + c as u32, |i| i as u32)
    }
    a.chars()
        .map(weight)
        .cmp(b.chars().map(weight))
        .then_with(|| {
            a.bytes()
                .map(|c| c.is_ascii_uppercase())
                .cmp(b.bytes().map(|c| c.is_ascii_uppercase()))
        })
}

#[cfg(test)]
mod tests;
