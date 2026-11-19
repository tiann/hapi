use serde_json::Value;

fn safe_integer(v: &Value, min: f64) -> bool {
    v.as_f64()
        .is_some_and(|n| n.fract() == 0.0 && n.abs() <= 9007199254740991.0 && n >= min)
}
fn text(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty())
}
pub fn opencode_rewind(v: &Value) -> bool {
    let Some(raw) = v.as_object() else {
        return false;
    };
    let field = |key: &str, check: &dyn Fn(&Value) -> bool| raw.get(key).is_some_and(check);
    let optional = |key: &str, check: &dyn Fn(&Value) -> bool| raw.get(key).is_none_or(check);
    let hash = |v: &Value| {
        v.as_str().is_some_and(|s| {
            s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        })
    };
    [
        "operationId",
        "nativeSessionId",
        "workerId",
        "requestedLocalId",
        "nativeMessageId",
    ]
    .iter()
    .all(|key| field(key, &text))
        && optional("workerPid", &|v| safe_integer(v, 1.0))
        && optional("workerStartMarker", &text)
        && field("cutoffSeq", &|v| safe_integer(v, 1.0))
        && ["sourceEpoch", "sourceMaxSeq", "reservationVersion"]
            .iter()
            .all(|key| field(key, &|v| safe_integer(v, 0.0)))
        && field("sourceTranscriptHash", &hash)
        && field("phase", &|v| {
            matches!(
                v.as_str(),
                Some("reserved" | "prepared" | "unknown" | "committed" | "rejected")
            )
        })
        && optional("sourceHash", &Value::is_string)
        && optional("prefixHash", &Value::is_string)
}
pub fn metadata(v: &Value) -> bool {
    v.is_object()
        && v["host"].is_string()
        && v["path"].is_string()
        && v.get("opencodeRewind").is_none_or(opencode_rewind)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn opencode_rewind_matches_typescript_schema() {
        let valid = json!({"operationId":"op","nativeSessionId":"n","workerId":"w","workerPid":7,"workerStartMarker":"m","requestedLocalId":"r","nativeMessageId":"nm","cutoffSeq":3,"sourceEpoch":0,"sourceMaxSeq":4,"reservationVersion":2,"sourceTranscriptHash":"a".repeat(64),"phase":"committed","sourceHash":"s","prefixHash":"p","extra":1});
        let mut cases = vec![
            valid.clone(),
            json!(null),
            json!("x"),
            json!([]),
            json!({"operationId":"op","phase":"committed"}),
        ];
        for (key, bad) in [
            ("operationId", json!("")),
            ("nativeSessionId", json!(1)),
            ("workerId", Value::Null),
            ("workerPid", json!(0)),
            ("workerPid", json!(1.5)),
            ("workerPid", Value::Null),
            ("workerStartMarker", json!("")),
            ("cutoffSeq", json!(0)),
            ("cutoffSeq", json!(2.0)),
            ("cutoffSeq", json!(9007199254740992u64)),
            ("sourceEpoch", json!(-1)),
            ("sourceMaxSeq", json!("1")),
            ("reservationVersion", json!(0.5)),
            ("sourceTranscriptHash", json!("A".repeat(64))),
            ("sourceTranscriptHash", json!("a".repeat(63))),
            ("phase", json!("done")),
            ("sourceHash", json!(1)),
            ("prefixHash", Value::Null),
        ] {
            let mut case = valid.clone();
            case[key] = bad;
            cases.push(case);
        }
        for key in ["nativeMessageId", "phase", "sourceTranscriptHash"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().shift_remove(key);
            cases.push(missing);
        }
        let mut optional = valid.clone();
        for key in [
            "workerPid",
            "workerStartMarker",
            "sourceHash",
            "prefixHash",
            "extra",
        ] {
            optional.as_object_mut().unwrap().shift_remove(key);
        }
        cases.push(optional);
        let script = format!(
            "import {{ MetadataSchema }} from '@hapi/protocol/schemas'; console.log(JSON.stringify({}.map(c => MetadataSchema.safeParse({{host:'h',path:'/',opencodeRewind:c}}).success)))",
            serde_json::to_string(&cases).unwrap()
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
        let expected: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
        let actual: Vec<_> = cases
            .iter()
            .map(|c| metadata(&json!({"host":"h","path":"/","opencodeRewind":c})))
            .collect();
        assert_eq!(actual, expected);
        assert!(metadata(&json!({"host":"h","path":"/"})));
        assert!(!metadata(&json!({"path":"/"})));
    }
}
