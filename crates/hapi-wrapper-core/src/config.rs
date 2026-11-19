use serde_json::Value;
use std::{env, io, path::PathBuf};

pub struct Config {
    pub home: PathBuf,
    pub api_url: String,
    pub cli_api_token: String,
    pub extra_headers: Vec<(String, String)>,
    pub machine_id: Option<String>,
}

impl Config {
    pub async fn load() -> io::Result<Self> {
        let home = env::home_dir().ok_or_else(|| io::Error::other("home directory unavailable"))?;
        Self::read(home, |k| env::var(k).ok()).await
    }

    async fn read(home: PathBuf, var: impl Fn(&str) -> Option<String>) -> io::Result<Self> {
        let home = match var("HAPI_HOME").filter(|s| !s.is_empty()) {
            Some(path) if path.starts_with('~') => {
                PathBuf::from(format!("{}{}", home.display(), &path[1..]))
            }
            Some(path) => PathBuf::from(path),
            None => home.join(".hapi"),
        };
        tokio::fs::create_dir_all(home.join("logs")).await?;
        let settings: Value = tokio::fs::read(home.join("settings.json"))
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        let field = |name: &str| {
            settings[name]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        };
        let api_url = var("HAPI_API_URL")
            .filter(|s| !s.is_empty())
            .or_else(|| field("apiUrl"))
            .or_else(|| field("serverUrl"))
            .unwrap_or_else(|| "http://localhost:3006".into());
        let cli_api_token = var("CLI_API_TOKEN").filter(|s| !s.is_empty()).or_else(|| field("cliApiToken")).ok_or_else(|| io::Error::other("CLI_API_TOKEN is required. Set it via environment variable or run `hapi auth login`."))?;
        let extra_headers = extra_headers(
            var("HAPI_EXTRA_HEADERS_JSON").as_deref(),
            settings.get("extraHeaders"),
            |msg| eprintln!("{msg}"),
        );
        Ok(Self {
            home,
            api_url,
            cli_api_token,
            extra_headers,
            machine_id: field("machineId"),
        })
    }
}

fn extra_headers(
    raw: Option<&str>,
    setting: Option<&Value>,
    mut warn: impl FnMut(&str),
) -> Vec<(String, String)> {
    let parsed;
    let (value, source) = match (raw, setting) {
        (Some(""), _) | (None, None) => return Vec::new(),
        (Some(raw), _) => {
            let Ok(value) = serde_json::from_str::<Value>(raw) else {
                warn("[WARN] Failed to parse HAPI_EXTRA_HEADERS_JSON. Ignoring value.");
                return Vec::new();
            };
            parsed = value;
            (&parsed, "HAPI_EXTRA_HEADERS_JSON")
        }
        (None, Some(value)) => (value, "settings.json extraHeaders"),
    };
    let Some(object) = value.as_object() else {
        warn(&format!(
            "[WARN] {source} must be a JSON object. Ignoring value."
        ));
        return Vec::new();
    };
    let headers: Vec<_> = object
        .iter()
        .filter_map(|(key, v)| Some((key.clone(), v.as_str()?.to_owned())))
        .collect();
    if headers.len() != object.len() {
        warn(&format!(
            "[WARN] {source} only supports string header values. Ignoring non-string entries."
        ));
    }
    headers
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tempfile::tempdir;
    #[test]
    fn header_warnings_identify_the_source_and_omit_values() {
        let settings = serde_json::json!({"good":"secret", "bad":["secret"]});
        for (raw, expected) in [
            (
                Some("secret"),
                Some("Failed to parse HAPI_EXTRA_HEADERS_JSON"),
            ),
            (
                Some(r#""secret""#),
                Some("HAPI_EXTRA_HEADERS_JSON must be a JSON object"),
            ),
            (
                None,
                Some("settings.json extraHeaders only supports string header values"),
            ),
            (Some(""), None),
        ] {
            let mut warnings = vec![];
            let headers = extra_headers(raw, Some(&settings), |w| warnings.push(w.to_owned()));
            assert_eq!(warnings.len(), usize::from(expected.is_some()));
            if let Some(message) = expected {
                assert!(warnings[0].contains(message));
                assert!(!warnings[0].contains("secret"));
            }
            assert_eq!(headers.len(), usize::from(raw.is_none()));
        }
    }

    #[tokio::test]
    async fn precedence_and_headers() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("custom");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("settings.json"),r#"{"apiUrl":"new","serverUrl":"old","cliApiToken":"token","machineId":"machine","extraHeaders":{"Cookie":"a","bad":3}}"#).unwrap();
        let read = |vars: BTreeMap<&'static str, &'static str>| {
            Config::read(dir.path().into(), move |key| {
                if key == "HAPI_HOME" {
                    Some("~/custom".into())
                } else {
                    vars.get(key).map(|v| v.to_string())
                }
            })
        };
        let c = read(BTreeMap::new()).await.unwrap();
        assert_eq!(c.home, path);
        assert_eq!(
            (
                c.api_url.as_str(),
                c.cli_api_token.as_str(),
                c.machine_id.as_deref()
            ),
            ("new", "token", Some("machine"))
        );
        assert_eq!(c.extra_headers, vec![("Cookie".into(), "a".into())]);
        for raw in ["", "bad", "[]", "null", "42"] {
            let c = read(BTreeMap::from([
                ("HAPI_EXTRA_HEADERS_JSON", raw),
                ("HAPI_API_URL", "env"),
                ("CLI_API_TOKEN", "override"),
            ]))
            .await
            .unwrap();
            assert!(c.extra_headers.is_empty());
            assert_eq!(
                (c.api_url.as_str(), c.cli_api_token.as_str()),
                ("env", "override")
            );
        }
        let c = read(BTreeMap::from([(
            "HAPI_EXTRA_HEADERS_JSON",
            r#"{"other":"first","Other":"only","bad":null}"#,
        )]))
        .await
        .unwrap();
        assert_eq!(
            c.extra_headers,
            vec![
                ("other".into(), "first".into()),
                ("Other".into(), "only".into())
            ]
        );
    }
    #[tokio::test]
    async fn legacy_and_defaults() {
        let dir = tempdir().unwrap();
        let read = || {
            Config::read(dir.path().into(), |k| {
                (k == "CLI_API_TOKEN").then(|| "t".into())
            })
        };
        let c = read().await.unwrap();
        assert_eq!(c.home, dir.path().join(".hapi"));
        assert_eq!(c.api_url, "http://localhost:3006");
        assert_eq!(c.machine_id, None);
        std::fs::write(c.home.join("settings.json"), r#"{"serverUrl":"legacy"}"#).unwrap();
        assert_eq!(read().await.unwrap().api_url, "legacy");
        assert!(Config::read(dir.path().into(), |_| None).await.is_err());
    }
}
