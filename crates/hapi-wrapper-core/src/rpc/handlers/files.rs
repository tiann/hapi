use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    os::unix::fs::OpenOptionsExt,
    sync::{Arc, Mutex},
    time::UNIX_EPOCH,
};

struct Image {
    id: String,
    bytes: Vec<u8>,
    mime: String,
    name: String,
}
#[derive(Clone, Default)]
pub struct GeneratedImages(Arc<Mutex<VecDeque<Image>>>);
impl GeneratedImages {
    pub fn insert(
        &self,
        id: String,
        bytes: Vec<u8>,
        mime: String,
        name: String,
    ) -> Result<(), String> {
        if bytes.len() > 25 << 20 {
            return Err("File is too large to display inline".into());
        }
        if !["image/", "audio/", "video/"]
            .iter()
            .any(|p| mime.starts_with(p))
            && mime != "application/octet-stream"
        {
            return Err("Unsupported generated media MIME type".into());
        }
        let mut images = self.0.lock().unwrap();
        let pos = images.iter().position(|i| i.id == id);
        let image = Image {
            id,
            bytes,
            mime,
            name,
        };
        if let Some(pos) = pos {
            images[pos] = image
        } else {
            images.push_back(image)
        }
        while images.len() > 100 || images.iter().map(|i| i.bytes.len()).sum::<usize>() > 100 << 20
        {
            images.pop_front();
        }
        Ok(())
    }
}
fn decode(s: &str) -> Vec<u8> {
    let mut chars = s
        .bytes()
        .take_while(|b| *b != b'=')
        .filter_map(|b| match b {
            b'-' => Some(b'+'),
            b'_' => Some(b'/'),
            b'+' | b'/' => Some(b),
            b if b.is_ascii_alphanumeric() => Some(b),
            _ => None,
        })
        .collect::<Vec<_>>();
    if chars.len() % 4 == 1 {
        chars.pop();
    }
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::general_purpose::NO_PAD.with_decode_allow_trailing_bits(true),
    );
    engine.decode(chars).unwrap_or_default()
}
fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn metadata(v: &mut Value, m: &Metadata) {
    v["size"] = json!(m.len());
    if let Ok(t) = m.modified() {
        let ms = match t.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as i64,
            Err(e) => -(e.duration().as_millis() as i64),
        };
        v["modified"] = json!(ms);
    }
}
fn kind(t: fs::FileType) -> &'static str {
    if t.is_dir() {
        "directory"
    } else if t.is_file() {
        "file"
    } else {
        "other"
    }
}
fn entries(p: &Path, depth: Option<u64>) -> Result<Vec<Value>, String> {
    let mut out = vec![];
    for entry in fs::read_dir(p).map_err(|e| fs_error(e, "scandir", p))? {
        let entry = entry.map_err(|e| fs_error(e, "scandir", p))?;
        let t = entry
            .file_type()
            .map_err(|e| fs_error(e, "lstat", &entry.path()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(d) = depth {
            if !t.is_symlink() {
                if let Some(v) = tree(&entry.path(), d) {
                    out.push(v)
                }
            }
        } else {
            let mut v = json!({"name":name,"type":kind(t)});
            if !t.is_symlink() {
                if let Ok(m) = entry.metadata() {
                    metadata(&mut v, &m)
                }
            }
            out.push(v)
        }
    }
    out.sort_by(|a, b| {
        (a["type"] != "directory")
            .cmp(&(b["type"] != "directory"))
            .then_with(|| compare_names(field(a, "name"), field(b, "name")))
    });
    Ok(out)
}
fn tree(p: &Path, d: u64) -> Option<Value> {
    let m = p.metadata().ok()?;
    let mut v = json!({"path":p.to_string_lossy(),"name":p.file_name().unwrap_or(p.as_os_str()).to_string_lossy(),"type":if m.is_dir(){"directory"}else{"file"}});
    metadata(&mut v, &m);
    if m.is_dir() && d > 0 {
        v["children"] = json!(entries(p, Some(d - 1)).ok()?);
    }
    Some(v)
}
fn read(p: &Path, max: Option<f64>) -> Result<Value, String> {
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(if max.is_some() {
            nix::libc::O_NONBLOCK
        } else {
            0
        })
        .open(p)
        .map_err(|e| fs_error(e, "open", p))?;
    let m = f.metadata().map_err(|e| fs_error(e, "fstat", p))?;
    let mut bytes = vec![];
    if let Some(max) = max {
        if !m.is_file() {
            return Err("Path is not a regular file".into());
        }
        if m.len() > max.min(10485760.) as u64 {
            return Err("File is too large to display inline".into());
        }
        bytes.resize(m.len() as usize, 0);
        f.read_exact(&mut bytes)
            .map_err(|_| "File changed while reading")?;
        if f.metadata().map_err(|e| fs_error(e, "fstat", p))?.len() != m.len() {
            return Err("File changed while reading".into());
        }
    } else {
        if m.is_dir() {
            return Err("EISDIR: illegal operation on a directory, read".into());
        }
        f.read_to_end(&mut bytes)
            .map_err(|e| fs_error(e, "read", p))?;
    }
    let mut v = json!({"success":true,"content":STANDARD.encode(bytes)});
    metadata(&mut v, &m);
    Ok(v)
}
fn handle(method: &str, root: &Path, data: Value) -> Result<Value, String> {
    if method == "statFiles" {
        let paths = data["paths"]
            .as_array()
            .filter(|p| p.len() <= 500)
            .ok_or("Invalid file paths")?;
        let mut entries = vec![];
        for path in paths {
            let raw = path.as_str().ok_or("Invalid file paths")?;
            let p = lexical(root, raw)?;
            let mut v = json!({"path":raw});
            if let Some(m) = canonical(root, &p).ok().and_then(|p| p.metadata().ok()) {
                v["type"] = json!(kind(m.file_type()));
                metadata(&mut v, &m)
            }
            entries.push(v);
        }
        return Ok(json!({"success":true,"entries":entries}));
    }
    let p = lexical(root, field(&data, "path"))?;
    match method {
        "readFile" => read(
            &canonical(root, &p)?,
            data["maxBytes"].as_f64().filter(|x| *x > 0.),
        ),
        "listDirectory" => {
            if let Err(e) = p.metadata() {
                return Err(fs_error(e, "scandir", &p));
            }
            canonical(root, &p)?;
            Ok(json!({"success":true,"entries":entries(&p,None)?}))
        }
        "getDirectoryTree" => {
            let d = data["maxDepth"].as_f64().unwrap_or(0.);
            if d < 0. {
                return Err("maxDepth must be non-negative".into());
            }
            canonical(root, &p).map_err(|_| "Failed to access the specified path")?;
            Ok(
                json!({"success":true,"tree":tree(&p,d.ceil() as u64).ok_or("Failed to access the specified path")?}),
            )
        }
        "writeFile" => {
            let bytes = decode(field(&data, "content"));
            let mut f = if let Some(expected) = data["expectedHash"].as_str() {
                let resolved = p.canonicalize().map_err(|e| {
                    if e.kind() == io::ErrorKind::NotFound {
                        "File does not exist but hash was provided".into()
                    } else {
                        fs_error(e, "realpath", &p)
                    }
                })?;
                let p = check_resolved(root, resolved)?;
                let mut f = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&p)
                    .map_err(|e| fs_error(e, "open", &p))?;
                let mut existing = Vec::new();
                f.read_to_end(&mut existing)
                    .map_err(|e| fs_error(e, "read", &p))?;
                let actual = hash(&existing);
                if actual != expected {
                    return Err(format!(
                        "File hash mismatch. Expected: {expected}, Actual: {actual}"
                    ));
                }
                use std::io::Seek;
                f.rewind()
                    .and_then(|_| f.set_len(0))
                    .map_err(|e| fs_error(e, "write", &p))?;
                f
            } else {
                if p == lexical(root, "")? {
                    return Err("File already exists but was expected to be new".into());
                }
                let parent = canonical(root, p.parent().unwrap_or(root))?;
                let p = parent.join(p.file_name().ok_or("Invalid file path")?);
                File::create_new(&p).map_err(|e| {
                    if e.kind() == io::ErrorKind::AlreadyExists {
                        "File already exists but was expected to be new".into()
                    } else {
                        fs_error(e, "open", &p)
                    }
                })?
            };
            f.write_all(&bytes).map_err(|e| fs_error(e, "write", &p))?;
            Ok(json!({"success":true,"hash":hash(&bytes)}))
        }
        _ => unreachable!(),
    }
}
pub fn register(manager: &RpcHandlerManager, root: &Path, images: &GeneratedImages) {
    for method in [
        "readFile",
        "readGeneratedImage",
        "writeFile",
        "listDirectory",
        "statFiles",
        "getDirectoryTree",
    ] {
        if method == "readGeneratedImage" {
            let images = images.clone();
            manager.register(method,move|v|{
                let images=images.clone();
                async move{
                    let store=images.0.lock().unwrap();
                    let reply=match store.iter().find(|i|i.id==field(&v,"id")){
                        Some(i)=>json!({"success":true,"content":STANDARD.encode(&i.bytes),"mimeType":i.mime,"fileName":i.name}),
                        None=>error("Generated image not found"),
                    };
                    Ok(Some(reply))
                }
            });
            continue;
        }
        let root = root.to_owned();
        manager.register(method, move |data| {
            let root = root.clone();
            async move {
                Ok(Some(
                    tokio::task::spawn_blocking(move || {
                        handle(method, &root, data).unwrap_or_else(error)
                    })
                    .await
                    .map_err(|e| e.to_string())?,
                ))
            }
        });
    }
}
