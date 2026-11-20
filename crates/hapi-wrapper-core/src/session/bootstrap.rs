use super::metadata;
use crate::{config::Config, rest::Rest};
use serde_json::{json, Value};
use std::{io, path::PathBuf};
use uuid::Uuid;

#[derive(Default)]
pub struct Options {
    pub flavor: String,
    pub runner: bool,
    pub working_directory: Option<PathBuf>,
    pub existing_id: Option<String>,
    pub reserved_id: Option<String>,
    pub tag: Option<String>,
    pub agent_state: Option<Value>,
    pub model: Option<String>,
    pub model_reasoning_effort: Option<String>,
    pub effort: Option<String>,
    pub overrides: metadata::Overrides,
}

pub struct Prepared {
    pub session_summary_contract: Option<bool>,
    pub auto_bridge_transient_model_errors: Option<bool>,
    pub session: Value,
    pub metadata: Value,
    pub base: Value,
}
fn check_existing(
    id: &str,
    flavor: &str,
    meta: &Value,
    overrides: &metadata::Overrides,
) -> io::Result<()> {
    if meta["codexRuntime"]["kind"] == "attached" {
        if !overrides
            .fields
            .get("codexRuntime")
            .and_then(Option::as_ref)
            .is_some_and(|v| v["kind"] == "attached")
        {
            return Err(io::Error::other(
                "Externally attached Codex sessions require hapi attach, not an owned cold resume",
            ));
        }
        if meta["conversationHistoryDiverged"] == true {
            return Err(io::Error::other(
                "Native history changed; use hapi attach --new-view to create a fresh projection",
            ));
        }
    }
    if flavor == "codex" && meta["codexArchivedFork"].is_object() {
        return Err(io::Error::other(format!("HAPI session {id} has a pending archived fork; retry that fork before resuming the source")));
    }
    if metadata::hub_archived(meta) {
        return Err(io::Error::other(format!("HAPI session {id} is hub-archived; refuse --existing-session-id reopen (use hub reopen to clear archive metadata first)")));
    }
    Ok(())
}
pub async fn prepare(rest: &Rest, config: &Config, opts: &Options) -> io::Result<Prepared> {
    let machine_id = config
        .machine_id
        .as_deref()
        .ok_or_else(|| io::Error::other("No machine ID found in settings"))?;
    let machine = metadata::machine(config).await?;
    rest.machine(machine_id, machine.clone()).await?;
    let existing = if let Some(id) = &opts.existing_id {
        let session = rest.session(id).await?;
        check_existing(
            id,
            &opts.flavor,
            &session.session["metadata"],
            &opts.overrides,
        )?;
        Some(session)
    } else {
        None
    };
    let cwd = opts
        .working_directory
        .clone()
        .map_or_else(metadata::invoked_cwd, Ok)?;
    let base = metadata::build(&machine, machine_id, &cwd, opts.runner, &opts.flavor).await?;
    if let Some(response) = existing {
        let session = response.session;
        let metadata = metadata::existing(&base, &session["metadata"], &opts.overrides);
        return Ok(Prepared {
            session_summary_contract: response.session_summary_contract,
            auto_bridge_transient_model_errors: response.auto_bridge_transient_model_errors,
            session,
            metadata,
            base,
        });
    }
    let metadata = opts.overrides.create(&base);
    let mut body = json!({"tag":opts.tag.clone().unwrap_or_else(||Uuid::new_v4().to_string()),"metadata":metadata,"agentState":opts.agent_state.clone().unwrap_or(json!({}))});
    for (key, val) in [
        ("model", &opts.model),
        ("modelReasoningEffort", &opts.model_reasoning_effort),
        ("effort", &opts.effort),
    ] {
        if let Some(s) = val {
            body[key] = s.clone().into();
        }
    }
    let reserved = opts.reserved_id.as_ref().filter(|s| {
        s.len() == 36
            && Uuid::try_parse(s).is_ok_and(|u| {
                u.is_nil()
                    || (u.is_max() && s.as_str() == "ffffffff-ffff-ffff-ffff-ffffffffffff")
                    || (u.get_variant() == uuid::Variant::RFC4122
                        && (1..=8).contains(&u.get_version_num()))
            })
    });
    if let Some(id) = reserved {
        body["id"] = json!(id);
        body["adopt"] = true.into();
    }
    let response = rest.create(body).await?;
    let session = response.session;
    if let Some(id) = reserved {
        if session["id"].as_str() != Some(id) {
            return Err(io::Error::other(format!(
                "Hub returned unexpected session id {} (reserved {id})",
                session["id"].as_str().unwrap_or_default()
            )));
        }
    }
    Ok(Prepared {
        session_summary_contract: response.session_summary_contract,
        auto_bridge_transient_model_errors: response.auto_bridge_transient_model_errors,
        session,
        metadata,
        base,
    })
}

pub struct Bootstrapped {
    pub session_summary_contract: Option<bool>,
    pub auto_bridge_transient_model_errors: Option<bool>,
    pub child_env: std::collections::BTreeMap<String, String>,
    pub client: std::sync::Arc<super::client::SessionClient>,
    pub events: tokio::sync::mpsc::UnboundedReceiver<super::client::SessionEvent>,
    pub session: Value,
    pub metadata: Value,
}
pub async fn bootstrap(
    config: &Config,
    opts: &Options,
    export_env: bool,
    report_started: bool,
    require_metadata_flush: impl FnOnce(&Value) -> bool,
) -> io::Result<Bootstrapped> {
    let rest = Rest::new(config).await?;
    let Prepared {
        session_summary_contract,
        auto_bridge_transient_model_errors,
        session,
        metadata,
        base,
    } = prepare(&rest, config, opts).await?;
    let empty_history = opts.existing_id.is_none() && opts.tag.is_none();
    let (client, events) =
        super::client::SessionClient::start_with(config, rest.clone(), &session, empty_history)?;
    if opts.existing_id.is_some() {
        let overrides = opts.overrides.clone();
        client
            .metadata
            .update(move |m| metadata::existing(&base, m, &overrides));
        if require_metadata_flush(&session["metadata"])
            && !client
                .flush_metadata(std::time::Duration::from_secs(5))
                .await
        {
            client.close();
            return Err(io::Error::other(
                "Unable to persist existing-session metadata",
            ));
        }
    }
    let mut child_env = std::collections::BTreeMap::new();
    if export_env {
        child_env.insert("HAPI_SESSION_ID".into(), client.id.clone());
    }
    if report_started {
        let _ = rest
            .report_started(&config.home, &client.id, &metadata)
            .await;
    }
    Ok(Bootstrapped {
        session_summary_contract,
        auto_bridge_transient_model_errors,
        child_env,
        client,
        events,
        session,
        metadata,
    })
}
