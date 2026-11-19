use crate::{config::Config, lifecycle::start_marker::start_marker};
use serde_json::{json, Value};
use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub(crate) fn spread(target: &mut Value, source: &Value) {
    if let (Some(a), Some(b)) = (target.as_object_mut(), source.as_object()) {
        a.extend(b.clone());
    }
}
fn required(key: &str) -> io::Result<String> {
    env::var(key)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| io::Error::other(format!("{key} is required")))
}
pub fn invoked_cwd() -> io::Result<PathBuf> {
    resolve_cwd(env::var("HAPI_INVOKED_CWD").ok())
}
fn resolve_cwd(invoked: Option<String>) -> io::Result<PathBuf> {
    invoked
        .map(|s| PathBuf::from(s.trim()))
        .filter(|p| p.is_absolute())
        .map_or_else(env::current_dir, Ok)
}
pub async fn machine(config: &Config) -> io::Result<Value> {
    let host = match env::var("HAPI_HOSTNAME").ok().filter(|s| !s.is_empty()) {
        Some(name) => name,
        None => hostname()?,
    };
    Ok(
        json!({"host":host,"platform":platform(),"happyCliVersion":required("HAPI_WRAPPER_CLI_VERSION")?,"homeDir":require_home(env::home_dir())?,"happyHomeDir":config.home,"happyLibDir":required("HAPI_WRAPPER_RUNTIME_PATH")?}),
    )
}
#[cfg(unix)]
fn hostname() -> io::Result<String> {
    nix::unistd::gethostname()?
        .into_string()
        .map_err(|_| io::Error::other("hostname is not valid UTF-8"))
}
#[cfg(not(unix))]
fn hostname() -> io::Result<String> {
    env::var("COMPUTERNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| io::Error::other("hostname unavailable"))
}
fn platform() -> &'static str {
    match env::consts::OS {
        "macos" | "ios" => "darwin",
        "windows" => "win32",
        "solaris" | "illumos" => "sunos",
        os => os,
    }
}
fn require_home(home: Option<PathBuf>) -> io::Result<PathBuf> {
    home.ok_or_else(|| io::Error::other("home directory unavailable"))
}
fn worktree() -> Option<Value> {
    env_worktree(|key| env::var(key).ok()).or_else(|| git_worktree(&invoked_cwd().ok()?))
}
fn env_worktree(read: impl Fn(&str) -> Option<String>) -> Option<Value> {
    let var = |key| {
        read(key)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    if let (Some(base), Some(branch), Some(name), Some(path), Some(time)) = (
        var("HAPI_WORKTREE_BASE_PATH"),
        var("HAPI_WORKTREE_BRANCH"),
        var("HAPI_WORKTREE_NAME"),
        var("HAPI_WORKTREE_PATH"),
        var("HAPI_WORKTREE_CREATED_AT")
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite()),
    ) {
        return Some(
            json!({"basePath":base,"branch":branch,"name":name,"worktreePath":path,"createdAt":time}),
        );
    }
    None
}
fn git_worktree(cwd: &Path) -> Option<Value> {
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    };
    if git(&["rev-parse", "--is-inside-work-tree"])?.as_str() != "true" {
        return None;
    }
    let dir = |arg| fs::canonicalize(cwd.join(git(&["rev-parse", arg])?)).ok();
    let common = dir("--git-common-dir")?;
    if common == dir("--git-dir")? {
        return None;
    }
    let path = dir("--show-toplevel")?;
    let branch = git(&["symbolic-ref", "--short", "HEAD"])
        .or_else(|| git(&["rev-parse", "--short", "HEAD"]))?;
    let time = fs::metadata(&path)
        .ok()
        .and_then(|m| {
            let birth = m
                .created()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| (d.as_nanos() + 500_000) / 1_000_000);
            let (secs, nanos) = changed_time(&m);
            timestamp_ms(birth, secs, nanos)
        })
        .unwrap_or_else(now);
    Some(
        json!({"basePath":common.parent()?,"branch":branch,"name":path.file_name()?.to_str()?,"worktreePath":path,"createdAt":time}),
    )
}
#[cfg(unix)]
fn changed_time(m: &fs::Metadata) -> (i64, i64) {
    use std::os::unix::fs::MetadataExt;
    (m.ctime(), m.ctime_nsec())
}
#[cfg(not(unix))]
fn changed_time(m: &fs::Metadata) -> (i64, i64) {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or((0, 0), |d| {
            (
                i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
                i64::from(d.subsec_nanos()),
            )
        })
}
fn timestamp_ms(birth: Option<u128>, ctime: i64, nanos: i64) -> Option<u64> {
    let changed = i128::from(ctime) * 1000 + (i128::from(nanos) + 500_000) / 1_000_000;
    birth
        .and_then(|n| u64::try_from(n).ok())
        .filter(|n| *n > 0)
        .or_else(|| u64::try_from(changed).ok().filter(|n| *n > 0))
}
pub async fn build(
    machine: &Value,
    id: &str,
    cwd: &Path,
    runner: bool,
    flavor: &str,
) -> io::Result<Value> {
    let lib = Path::new(
        machine["happyLibDir"]
            .as_str()
            .ok_or_else(|| io::Error::other("Missing happyLibDir"))?,
    );
    let mut v = json!({
        "path":cwd, "host":machine["host"], "os":platform(),
        "version":machine["happyCliVersion"],
        "happyLibDir":lib, "happyHomeDir":machine["happyHomeDir"],
        "happyToolsDir":std::path::absolute(lib.join("tools/unpacked"))?,
        "machineId":id, "hostPid":std::process::id(), "startedFromRunner":runner,
        "startedBy":if runner {"runner"} else {"terminal"},
        "lifecycleState":"running", "lifecycleStateSince":now(), "flavor":flavor,
        "capabilities":{"terminal":true}, "wrapperRuntime":"rust"
    });
    if let Some(home) = machine["homeDir"].as_str() {
        v["homeDir"] = home.into();
    }
    if runner {
        if let Some(marker) = start_marker(std::process::id()).await {
            v["hostStartMarker"] = marker.into();
        }
    }
    if let Some(tree) = tokio::task::spawn_blocking(worktree).await? {
        v["worktree"] = tree;
    }
    Ok(v)
}
#[derive(Default, Clone)]
pub struct Overrides {
    pub fields: std::collections::BTreeMap<String, Option<Value>>,
    pub capabilities: std::collections::BTreeMap<String, Option<Value>>,
}
impl Overrides {
    fn patch(base: &Value, fields: &std::collections::BTreeMap<String, Option<Value>>) -> Value {
        Value::Object(crate::jsjson::merge(
            base.as_object().unwrap_or(&Default::default()),
            fields.clone(),
        ))
    }
    pub fn create(&self, base: &Value) -> Value {
        let mut out = Self::patch(base, &self.fields);
        if !self.capabilities.is_empty() {
            out["capabilities"] = Self::patch(&out["capabilities"], &self.capabilities);
        }
        out
    }
}
pub fn existing(base: &Value, current: &Value, overrides: &Overrides) -> Value {
    let mut out = base.clone();
    for key in [
        "name",
        "summary",
        "acpManualTitle",
        "claudeSessionId",
        "claudeSessionIdHistory",
        "codexSessionId",
        "codexRuntime",
        "codexSourceSessionId",
        "geminiSessionId",
        "opencodeSessionId",
        "grokSessionId",
        "agySessionId",
        "cursorSessionId",
        "cursorSessionProtocol",
        "kimiSessionId",
        "copilotSessionId",
        "piSessionId",
        "dshSessionId",
        "piResumeAttempt",
        "ptyResumeAttempt",
        "preferredPermissionMode",
        "tools",
        "slashCommands",
        "worktree",
        "piAvailableModels",
        "piSelectedModel",
        "externalRefs",
        "conversationHistoryPoints",
        "conversationHistoryIndexes",
        "opencodeHistoryCheckpoint",
        "opencodeRewind",
        "opencodeWorkerId",
        "opencodeForkPending",
        "conversationHistoryTurns",
        "conversationHistoryEntryIds",
        "conversationHistoryDiverged",
        "claudeRewind",
        "forkedFrom",
    ] {
        if key == "claudeRewind" {
            if let Some(mut rewind) = claude_rewind(current) {
                if rewind["hubCutApplied"] == true {
                    rewind
                        .as_object_mut()
                        .unwrap()
                        .shift_remove("hubCutApplied");
                }
                out[key] = rewind;
            }
        } else if let Some(value) = current.get(key) {
            out[key] = value.clone();
        }
    }
    let mut caps = base["capabilities"].clone();
    if let Some(v) = current["capabilities"].get("conversationHistory") {
        caps["conversationHistory"] = v.clone();
    }
    out = Overrides::patch(&out, &overrides.fields);
    if let Some(Some(values)) = overrides.fields.get("capabilities") {
        spread(&mut caps, values);
    }
    out["capabilities"] = Overrides::patch(&caps, &overrides.capabilities);
    out
}
pub(crate) fn claude_rewind(metadata: &Value) -> Option<Value> {
    let raw = metadata.get("claudeRewind")?.as_object()?;
    let text = |v: &Value| v.as_str().is_some_and(|s| !s.is_empty());
    let mut out = serde_json::Map::new();
    for key in ["targetLocalId", "truncateFromLocalId", "keepBoundary"] {
        out.insert(key.into(), raw.get(key).filter(|v| text(v))?.clone());
    }
    out.insert(
        "droppedPrompts".into(),
        raw.get("droppedPrompts")
            .filter(|v| v.as_array().is_some_and(|a| a.iter().all(text)))?
            .clone(),
    );
    if let Some(v) = raw.get("hubCutApplied") {
        out.insert("hubCutApplied".into(), v.is_boolean().then(|| v.clone())?);
    }
    if let Some(v) = raw.get("discardedThroughSeq") {
        let seq = v
            .as_f64()
            .filter(|n| *n >= 0.0 && n.fract() == 0.0 && *n <= 9007199254740991.0)
            .map(|n| n as u64)?;
        out.insert("discardedThroughSeq".into(), seq.into());
    }
    Some(Value::Object(out))
}
pub fn hub_archived(value: &Value) -> bool {
    value["lifecycleState"] == "archived" && value["archivedBy"] == "hub"
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn undefined_and_null_overrides() {
        let base = json!({"host":"test","capabilities":{"terminal":true}});
        let current =
            json!({"name":"old","capabilities":{"conversationHistory":{"rewindToMessage":true}}});
        let patch = Overrides {
            fields: [("name".into(), None), ("summary".into(), Some(Value::Null))].into(),
            capabilities: [
                ("conversationHistory".into(), None),
                ("concurrentClients".into(), Some(true.into())),
            ]
            .into(),
        };
        let expected = json!({"host":"test","summary":null,"capabilities":{"terminal":true,"concurrentClients":true}});
        assert_eq!(existing(&base, &current, &patch), expected);
        assert_eq!(patch.create(&base), expected);
    }
    #[test]
    fn reopen_preserves_claude_rewind_like_typescript() {
        let base = json!({"host":"test","path":"/","capabilities":{"terminal":true}});
        let intent = json!({"targetLocalId":"t","truncateFromLocalId":"cut","keepBoundary":"k","droppedPrompts":["p"],"discardedThroughSeq":7});
        let mut applied = intent.clone();
        applied["hubCutApplied"] = true.into();
        applied["extra"] = 1.into();
        let current = json!({"claudeRewind":applied,"externalRefs":[]});
        let out = existing(&base, &current, &Overrides::default());
        assert_eq!(out["claudeRewind"], intent);
        assert_eq!(out["externalRefs"], current["externalRefs"]);
        let mut pending = intent.clone();
        pending["hubCutApplied"] = false.into();
        let out = existing(
            &base,
            &json!({"claudeRewind":pending}),
            &Overrides::default(),
        );
        assert_eq!(out["claudeRewind"], pending);
        assert!(existing(&base, &json!({}), &Overrides::default())
            .get("claudeRewind")
            .is_none());
    }
    #[test]
    fn claude_rewind_matches_typescript_schema() {
        let valid = json!({"discardedThroughSeq":3,"extra":true,"droppedPrompts":["a","b"],"keepBoundary":"k","truncateFromLocalId":"c","targetLocalId":"t","hubCutApplied":false});
        let mut cases = vec![valid.clone(), json!(null), json!("x"), json!([])];
        for (key, bad) in [
            ("targetLocalId", json!("")),
            ("truncateFromLocalId", json!(1)),
            ("keepBoundary", Value::Null),
            ("droppedPrompts", json!([""])),
            ("droppedPrompts", json!("a")),
            ("hubCutApplied", json!("yes")),
            ("hubCutApplied", Value::Null),
            ("discardedThroughSeq", json!(-1)),
            ("discardedThroughSeq", json!(1.5)),
            ("discardedThroughSeq", json!(2.0)),
            ("discardedThroughSeq", json!(9007199254740992u64)),
        ] {
            let mut case = valid.clone();
            case[key] = bad;
            cases.push(case);
        }
        let mut missing = valid.clone();
        missing
            .as_object_mut()
            .unwrap()
            .shift_remove("keepBoundary");
        cases.push(missing);
        let mut optional = valid.clone();
        for key in ["hubCutApplied", "discardedThroughSeq", "extra"] {
            optional.as_object_mut().unwrap().shift_remove(key);
        }
        cases.push(optional);
        let script = format!(
            "import {{ MetadataSchema }} from '@hapi/protocol/schemas'; console.log(JSON.stringify({}.map(c => MetadataSchema.parse({{host:'h',path:'/',claudeRewind:c}}).claudeRewind ?? null)))",
            serde_json::to_string(&cases).unwrap()
        );
        let output = Command::new("bun")
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../cli"))
            .args(["-e", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
        let actual: Vec<_> = cases
            .iter()
            .map(|c| claude_rewind(&json!({"claudeRewind":c})).unwrap_or(Value::Null))
            .collect();
        assert_eq!(
            serde_json::to_string(&actual).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
    }
    #[test]
    fn host_discovery_matches_node_os() {
        let output = std::process::Command::new("node")
            .args([
                "-p",
                "JSON.stringify([require('os').hostname(),require('os').platform()])",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        let expected: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(json!([hostname().unwrap(), platform()]), expected);
    }
    #[tokio::test]
    async fn missing_home() {
        assert!(require_home(None).is_err());
        let meta = build(
            &json!({"happyLibDir":"/runtime"}),
            "m",
            Path::new("/"),
            false,
            "claude",
        )
        .await
        .unwrap();
        assert!(meta.get("homeDir").is_none());
    }
    #[test]
    fn worktree_environment_and_invoked_directory() {
        let vars = std::collections::HashMap::from([
            ("HAPI_WORKTREE_BASE_PATH", " /base "),
            ("HAPI_WORKTREE_NAME", "feature"),
            ("HAPI_WORKTREE_BRANCH", "topic"),
            ("HAPI_WORKTREE_PATH", "/tree"),
            ("HAPI_WORKTREE_CREATED_AT", " 123 "),
        ]);
        assert_eq!(
            env_worktree(|k| vars.get(k).map(|s| s.to_string())).unwrap(),
            json!({"basePath":"/base","name":"feature","branch":"topic","worktreePath":"/tree","createdAt":123.0})
        );
        assert!(env_worktree(|_| None).is_none());
        assert_eq!(
            resolve_cwd(Some(" /tree ".into())).unwrap(),
            Path::new("/tree")
        );
        assert_eq!(
            resolve_cwd(Some("relative".into())).unwrap(),
            std::env::current_dir().unwrap()
        );
    }
    #[test]
    fn git_worktree_and_positive_creation_time() {
        let tmp = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            assert!(Command::new("git")
                .args(args)
                .current_dir(tmp.path())
                .output()
                .unwrap()
                .status
                .success())
        };
        git(&["init", "main"]);
        git(&[
            "-C",
            "main",
            "-c",
            "user.email=t@example.invalid",
            "-c",
            "user.name=test",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "fixture",
        ]);
        git(&["-C", "main", "worktree", "add", "-b", "topic", "../linked"]);
        assert!(git_worktree(&tmp.path().join("main")).is_none());
        let linked = git_worktree(&tmp.path().join("linked")).unwrap();
        assert_eq!(linked["branch"], "topic");
        assert_eq!(linked["name"], "linked");
        assert_eq!(linked["basePath"], json!(tmp.path().join("main")));
        assert!(linked["createdAt"].as_u64().unwrap() > 0);
        assert_eq!(timestamp_ms(Some(123), 5, 0), Some(123));
        assert_eq!(timestamp_ms(Some(0), 5, 1_500_000), Some(5002));
        assert_eq!(timestamp_ms(None, -1, 0), None);
        assert_eq!(timestamp_ms(None, 0, 0), None);
    }
}
