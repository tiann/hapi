use super::*;
use std::{fs, os::unix::fs::symlink};
use tempfile::tempdir;
struct Fixture {
    dir: tempfile::TempDir,
    rpc: RpcHandlerManager,
    images: GeneratedImages,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempdir().unwrap();
        let rpc = RpcHandlerManager::new("s");
        let images = GeneratedImages::default();
        files::register(&rpc, dir.path(), &images);
        Self { dir, rpc, images }
    }
    async fn call(&self, m: &str, v: Value) -> Value {
        serde_json::from_str(
            &self
                .rpc
                .handle_request(&json!({"method":format!("s:{m}"),"params":v.to_string()}))
                .await
                .unwrap(),
        )
        .unwrap()
    }
}
#[test]
fn lexical_boundaries() {
    let root = Path::new("/home/user/project");
    for raw in [
        "/home/user/project/file.txt",
        "file.txt",
        "./src/file.txt",
        ".",
        "/home/user/project",
    ] {
        assert!(lexical(root, raw).is_ok())
    }
    for raw in [
        "/etc/passwd",
        "../../.ssh/id_rsa",
        "/home/user/project2/file.txt",
    ] {
        assert!(lexical(root, raw).is_err())
    }
    assert!(lexical(Path::new("/"), "/etc/passwd").is_ok());
}
#[tokio::test]
async fn bounded_file_reads() {
    let f = Fixture::new();
    let dir = f.dir.path();
    let outside = tempdir().unwrap();
    fs::write(dir.join("README.md"), "# test").unwrap();
    let reply = f.call("readFile", json!({"path":"README.md"})).await;
    assert_eq!(reply["size"], 6);
    assert_eq!(reply["content"], "IyB0ZXN0");
    assert!(reply["modified"].is_number());
    fs::File::create(dir.join("sparse"))
        .unwrap()
        .set_len(1000000000)
        .unwrap();
    fs::create_dir(dir.join("sub")).unwrap();
    symlink(dir.join("sub"), dir.join("link")).unwrap();
    fs::write(outside.path().join("secret"), "secret").unwrap();
    symlink(outside.path().join("secret"), dir.join("secret")).unwrap();
    for (path, max, msg) in [
        ("README.md", 1, "too large"),
        ("sparse", 16, "too large"),
        ("sub", 16, "regular file"),
        ("link", 16, "regular file"),
        ("secret", 16, "outside"),
    ] {
        let v = f
            .call("readFile", json!({"path":path,"maxBytes":max}))
            .await;
        assert!(field(&v, "error").contains(msg));
    }
}
#[tokio::test]
async fn directories_and_stat() {
    let f = Fixture::new();
    let dir = f.dir.path();
    let outside = tempdir().unwrap();
    fs::create_dir(dir.join("src")).unwrap();
    fs::write(dir.join("README.md"), "# test").unwrap();
    symlink(outside.path(), dir.join("linked")).unwrap();
    symlink("absent", dir.join("bad-link")).unwrap();
    let v = f.call("listDirectory", json!({"path":""})).await;
    let entries = v["entries"].as_array().unwrap();
    assert_eq!(entries[0]["name"], "src");
    assert!(entries.contains(&json!({"name":"bad-link","type":"other"})));
    let v = f
        .call(
            "statFiles",
            json!({"paths":["README.md","src","missing","linked"]}),
        )
        .await;
    assert_eq!(v["entries"][0]["size"], 6);
    assert_eq!(v["entries"][1]["type"], "directory");
    assert_eq!(v["entries"][2], json!({"path":"missing"}));
    assert_eq!(v["entries"][3], json!({"path":"linked"}));
    assert_eq!(
        f.call("statFiles", json!({"paths":["../no"]})).await["success"],
        false
    );
    assert_eq!(
        f.call("getDirectoryTree", json!({"path":".","maxDepth":1}))
            .await["tree"]["children"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}
#[tokio::test]
async fn writes_and_generated_images() {
    let f = Fixture::new();
    let req = json!({"path":"file","content":"YQ"});
    let v = f.call("writeFile", req.clone()).await;
    assert!(v["hash"].is_string());
    assert_eq!(
        f.call("writeFile", req).await["error"],
        "File already exists but was expected to be new"
    );
    assert_eq!(
        f.call(
            "writeFile",
            json!({"path":"file","content":"Yg","expectedHash":v["hash"]})
        )
        .await["success"],
        true
    );
    f.images
        .insert("i".into(), vec![1], "image/png".into(), "i.png".into())
        .unwrap();
    assert_eq!(
        f.call("readGeneratedImage", json!({"id":"i"})).await["content"],
        "AQ=="
    );
}
#[tokio::test]
async fn canonical_workspace_and_file_errors() {
    use std::os::unix::ffi::OsStrExt;
    let f = Fixture::new();
    let root = f.dir.path();
    let other = tempdir().unwrap();
    symlink(other.path(), root.join("linked")).unwrap();
    let payload = json!({"path":"linked/new","content":"YQ=="});
    let denied = "Access denied: resolved path is outside the working directory";
    assert_eq!(f.call("writeFile", payload).await, error(denied));
    assert!(!other.path().join("new").exists());
    fs::write(other.path().join("old"), "abc").unwrap();
    symlink(other.path().join("old"), root.join("outside")).unwrap();
    assert_eq!(
        f.call(
            "writeFile",
            json!({"path":"outside","expectedHash":"irrelevant","content":"YQ=="})
        )
        .await,
        error(denied)
    );
    symlink(other.path().join("absent"), root.join("dangling")).unwrap();
    assert_eq!(
        f.call("writeFile", json!({"path":"dangling","content":"YQ=="}))
            .await,
        error("File already exists but was expected to be new")
    );
    assert!(!other.path().join("absent").exists());
    for (path, msg) in [
        (".", "File already exists but was expected to be new"),
        ("missing", "File does not exist but hash was provided"),
    ] {
        let mut v = json!({"path":path,"content":"YQ=="});
        if path == "missing" {
            v["expectedHash"] = json!("bad")
        }
        assert_eq!(f.call("writeFile", v).await, error(msg));
    }
    fs::write(root.join("file"), "abc").unwrap();
    assert_eq!(f.call("writeFile",json!({"path":"file","expectedHash":"bad"})).await,error("File hash mismatch. Expected: bad, Actual: ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    let v = f
        .call(
            "writeFile",
            json!({"path":"file/child","expectedHash":"bad"}),
        )
        .await;
    assert!(field(&v, "error").starts_with("ENOTDIR:"));
    assert_eq!(
        f.call("listDirectory", json!({"path":"linked"})).await,
        error(denied)
    );
    assert_eq!(
        f.call("getDirectoryTree", json!({"path":"linked"})).await,
        error("Failed to access the specified path")
    );
    let strange = root.join(std::ffi::OsStr::from_bytes(b"bad-\xff"));
    fs::write(&strange, "").unwrap();
    let response = f
        .call("getDirectoryTree", json!({"path":".","maxDepth":1}))
        .await;
    assert!(response["tree"]["children"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n["name"] == "bad-�" && n["path"] == strange.to_string_lossy().as_ref()));
    assert_eq!(
        lexical(&root.join("nonexistent/../."), "file").unwrap(),
        root.join("file")
    );
    let rpc = RpcHandlerManager::new("s");
    files::register(
        &rpc,
        &root.join("nonexistent/.."),
        &GeneratedImages::default(),
    );
    let result = rpc
        .handle_request(&json!({"method":"s:readFile","params":"{\"path\":\"file\"}"}))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&result).unwrap()["success"],
        true
    );
}
#[tokio::test]
async fn bounded_fifo_read_returns_without_writer() {
    let f = Fixture::new();
    let fifo = f.dir.path().join("fifo");
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRWXU).unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        f.call("readFile", json!({"path":"fifo","maxBytes":100})),
    )
    .await;
    if result.is_err() {
        let _ = fs::OpenOptions::new().read(true).write(true).open(&fifo);
    }
    assert_eq!(result.unwrap(), error("Path is not a regular file"));
}
#[test]
fn locale_order_matches_ascii_fixture() {
    let mut names = [
        "Az", "_b", "Z", "aa", "z", "-b", "ab", "Ab", "aB", "AB", ".b", "0", "é", "ä",
    ];
    names.sort_by(|a, b| compare_names(a, b));
    assert_eq!(
        names,
        ["_b", "-b", ".b", "0", "aa", "ab", "aB", "Ab", "AB", "Az", "z", "Z", "ä", "é"]
    );
}

#[test]
fn ascii_order_matches_typescript_locale_compare() {
    let chars: Vec<String> = (b' '..=b'~').map(|b| (b as char).to_string()).collect();
    let mut names = chars.clone();
    for a in "aA_-. 1~$Zz".chars() {
        for b in "aA_-. 1~$Zz".chars() {
            names.push(format!("{a}{b}"));
        }
    }
    for (i, a) in chars.iter().enumerate() {
        names.push(format!("x{a}{}", chars[(i * 7) % chars.len()]));
    }
    names.sort();
    names.dedup();
    let script = format!(
        "console.log(JSON.stringify({}.sort((a, b) => a.localeCompare(b))))",
        serde_json::to_string(&names).unwrap()
    );
    let output = std::process::Command::new("bun")
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../cli"))
        .args(["-e", &script])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
    names.sort_by(|a, b| compare_names(a, b));
    assert_eq!(names, expected);
}

#[tokio::test]
async fn conditional_writes_keep_content_and_skip_special_files() {
    let f = Fixture::new();
    let dir = f.dir.path();
    fs::write(dir.join("file"), "abc").unwrap();
    let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    let missing = "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined";
    assert_eq!(
        f.call("writeFile", json!({"path":"file","expectedHash":abc}))
            .await,
        error(missing)
    );
    assert_eq!(fs::read(dir.join("file")).unwrap(), b"abc");
    assert_eq!(
        f.call("writeFile", json!({"path":"new","content":null}))
            .await,
        error(missing.replace("undefined", "null"))
    );
    assert!(!dir.join("new").exists());
    assert_eq!(
        f.call("writeFile", json!({"path":"file"})).await,
        error("File already exists but was expected to be new")
    );
    assert_eq!(
        f.call(
            "writeFile",
            json!({"path":"file","expectedHash":abc,"content":""})
        )
        .await["hash"],
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(fs::read(dir.join("file")).unwrap(), b"");
    let fifo = dir.join("fifo");
    nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRWXU).unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        f.call(
            "writeFile",
            json!({"path":"fifo","expectedHash":abc,"content":"YQ=="}),
        ),
    )
    .await;
    if result.is_err() {
        let _ = fs::write(&fifo, "x");
    }
    assert_eq!(result.unwrap(), error("Path is not a regular file"));
}
