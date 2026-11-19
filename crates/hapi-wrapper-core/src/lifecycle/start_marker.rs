#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    use nix::{sys::signal::kill, unistd::Pid};
    i32::try_from(pid).is_ok_and(|id| id > 0 && kill(Pid::from_raw(id), None).is_ok())
}
#[cfg(not(unix))]
pub fn alive(_pid: u32) -> bool {
    false
}

#[cfg(not(unix))]
pub async fn start_marker(_pid: u32) -> Option<String> {
    None
}
#[cfg(unix)]
pub async fn start_marker(pid: u32) -> Option<String> {
    if !alive(pid) {
        return None;
    }
    let output = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "lstart="])
            .env("LC_ALL", "C")
            .env("TZ", "UTC")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    let marker = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (output.status.success() && !marker.is_empty()).then_some(marker)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn matches_typescript_for_live_children() {
        let mut children = Vec::new();
        for i in 0..50 {
            if i == 25 {
                tokio::time::sleep(Duration::from_millis(1050)).await;
            }
            children.push(
                tokio::process::Command::new("sleep")
                    .arg("60")
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap(),
            );
        }
        let mut args = Vec::new();
        for child in &children {
            args.push(child.id().unwrap().to_string());
        }
        let output=tokio::process::Command::new("bun").current_dir(concat!(env!("CARGO_MANIFEST_DIR"),"/../../cli")).args(["-e","import {getProcessStartMarker as m} from './src/utils/process.ts'; console.log(JSON.stringify(process.argv.slice(1).map(p=>m(Number(p)))))"]).args(args).output().await.unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(expected.len(), children.len());
        for (mut child, marker) in children.into_iter().zip(expected) {
            assert_eq!(start_marker(child.id().unwrap()).await, Some(marker));
            child.kill().await.unwrap();
        }
    }
}
