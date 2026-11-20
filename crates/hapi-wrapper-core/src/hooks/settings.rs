use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io,
    path::{Path, PathBuf},
};

fn quote(s: &str) -> String {
    if !s.is_empty()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_/:=-".contains(&c))
    {
        return s.to_owned();
    }
    let mut out = String::from("\"");
    for c in s.chars() {
        if matches!(c, '"' | '\\' | '$' | '`') {
            out.push('\\')
        }
        out.push(c)
    }
    out.push('"');
    out
}
pub fn build(command: &str, enabled: Option<bool>, track: bool, local: bool) -> Value {
    let cmd = json!({"type":"command","command":command});
    let entry = |matcher: Option<&str>| {
        let mut v = json!({});
        if let Some(m) = matcher {
            v["matcher"] = json!(m)
        }
        v["hooks"] = json!([cmd]);
        json!([v])
    };
    let mut hooks = json!({"SessionStart":entry(Some("*")),"PreCompact":entry(Some("auto"))});
    if track || local {
        hooks["UserPromptSubmit"] = entry(None);
        hooks["PreToolUse"] = entry(Some("*"));
        hooks["PostModelSwitch"] = entry(None)
    }
    if local {
        hooks["PermissionRequest"] = entry(Some("*"));
        hooks["PermissionRequest"][0]["hooks"][0]["timeout"] = json!(3600);
        for name in ["PostToolUse", "PostToolUseFailure", "SessionEnd"] {
            hooks[name] = entry(Some("*"))
        }
        for name in ["Stop", "StopFailure"] {
            hooks[name] = entry(None)
        }
    }
    let mut settings = json!({"hooks":hooks});
    if let Some(value) = enabled {
        settings["hooksConfig"] = json!({"enabled":value})
    }
    settings
}
fn pretty(value: &Value) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    value.serialize(&mut serde_json::Serializer::with_formatter(
        &mut out, formatter,
    ))?;
    Ok(out)
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Options<'a> {
    pub filename_prefix: &'a str,
    pub hooks_enabled: Option<bool>,
    pub track_permission_mode: bool,
    pub include_local_permissions: bool,
}
pub async fn generate(
    home: &Path,
    port: u16,
    token: &str,
    options: Options<'_>,
) -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let command = [
        exe.to_str()
            .ok_or_else(|| io::Error::other("Invalid executable path"))?,
        "hook-forwarder",
        "--flavor",
        "claude",
        "--port",
        &port.to_string(),
        "--token",
        token,
    ]
    .map(quote)
    .join(" ");
    let dir = home.join("tmp/hooks");
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(format!(
        "{}-{}.json",
        options.filename_prefix,
        std::process::id()
    ));
    let temp = dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut open = tokio::fs::OpenOptions::new();
    open.create_new(true).write(true);
    #[cfg(unix)]
    open.mode(0o600);
    let mut file = open.open(&temp).await?;
    use tokio::io::AsyncWriteExt;
    let write = async {
        file.write_all(&pretty(&build(
            &command,
            options.hooks_enabled,
            options.track_permission_mode,
            options.include_local_permissions,
        ))?)
        .await?;
        file.flush().await?;
        tokio::fs::rename(&temp, &path).await
    }
    .await;
    if let Err(e) = write {
        let _ = tokio::fs::remove_file(temp).await;
        return Err(e);
    }
    Ok(path)
}
pub async fn cleanup(path: &Path) -> io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn settings_and_cleanup() {
        let home = tempfile::tempdir().unwrap();
        let remote = Options {
            filename_prefix: "session-hook",
            ..Options::default()
        };
        let path = generate(home.path(), 1234, "t $x", remote).await.unwrap();
        let local_path = generate(
            home.path(),
            1234,
            "t $x",
            Options {
                filename_prefix: "session-hook-local",
                track_permission_mode: true,
                include_local_permissions: true,
                ..Options::default()
            },
        )
        .await
        .unwrap();
        assert_ne!(path, local_path);
        let local_file: Value =
            serde_json::from_slice(&tokio::fs::read(&local_path).await.unwrap()).unwrap();
        assert_eq!(
            local_file["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"],
            3600
        );
        assert_eq!(local_file["hooks"]["PreToolUse"][0]["matcher"], "*");
        let settings: Value =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(settings["hooks"].as_object().unwrap().len(), 2);
        assert_eq!(settings["hooks"]["PreCompact"][0]["matcher"], "auto");
        let text = String::from_utf8(tokio::fs::read(&path).await.unwrap()).unwrap();
        assert!(text.starts_with("{\n    \"hooks\": {\n        \"SessionStart\": ["));
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(
            keys(&settings["hooks"]["SessionStart"][0]),
            ["matcher", "hooks"]
        );
        let cmd = settings["hooks"]["SessionStart"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        assert_eq!(
            cmd,
            format!(
                "{} hook-forwarder --flavor claude --port 1234 --token \"t \\$x\"",
                quote(std::env::current_exe().unwrap().to_str().unwrap())
            )
        );
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            format!("session-hook-{}.json", std::process::id())
        );
        cleanup(&path).await.unwrap();
        cleanup(&local_path).await.unwrap();
        assert!(!path.exists());
        let tracked = build("cmd", Some(false), true, false);
        assert_eq!(tracked["hooksConfig"]["enabled"], false);
        for event in ["UserPromptSubmit", "PreToolUse", "PostModelSwitch"] {
            assert_eq!(tracked["hooks"][event][0]["hooks"][0]["command"], "cmd")
        }
        assert!(tracked["hooks"].get("Stop").is_none());
        let local = build("cmd", None, false, true);
        assert_eq!(
            local["hooks"]["PermissionRequest"][0]["hooks"][0],
            json!({"command":"cmd","type":"command","timeout":3600})
        );
        for event in [
            "PostToolUse",
            "PostToolUseFailure",
            "SessionEnd",
            "Stop",
            "StopFailure",
            "PreToolUse",
        ] {
            assert!(local["hooks"][event][0]["hooks"][0]
                .get("timeout")
                .is_none())
        }
    }
}
