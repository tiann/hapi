use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::UNIX_EPOCH;

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use sha2::{Digest, Sha256};

const LAUNCHD_LABEL: &str = "com.hapi.runner";
const SYSTEMD_UNIT: &str = "hapi-runner.service";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServiceSpec {
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServicePaths {
    home: PathBuf,
    logs_dir: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceAction {
    Install,
    Uninstall,
    Status,
    RenderLaunchd,
    RenderSystemd,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServiceOptions {
    action: ServiceAction,
    spec: ServiceSpec,
    paths: ServicePaths,
}

fn main() {
    if let Err(error) = run(env::args_os().skip(1).collect()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(args: Vec<OsString>) -> Result<(), String> {
    let first = args.first().and_then(|value| value.to_str()).unwrap_or("");
    match first {
        "--version" | "-V" | "version" => {
            println!("hapi-local {VERSION}");
            Ok(())
        }
        "doctor" => {
            println!("{}", doctor_json());
            Ok(())
        }
        "service" => run_service(args.into_iter().skip(1).collect()),
        "process" => run_process(args.into_iter().skip(1).collect()),
        "fs" => run_fs(args.into_iter().skip(1).collect()),
        "pty" => run_pty(args.into_iter().skip(1).collect()),
        "--help" | "-h" | "" => {
            print_usage();
            Ok(())
        }
        _ => Err(format!("unknown command: {first}")),
    }
}

fn print_usage() {
    println!(
        "hapi-local --version|doctor\n\
         hapi-local service install|uninstall|status|render-launchd|render-systemd \\\n\
         --command <path> [--arg <arg> ...] [--home <dir>] [--logs-dir <dir>]\n\
         hapi-local process kill-tree|spawn-detached|spawn-supervised\n\
         hapi-local fs list-dir|tree|read-file|write-file\n\
         hapi-local pty spawn"
    );
}

fn doctor_json() -> String {
    format!(
        "{{\"name\":\"hapi-local\",\"version\":{},\"os\":{},\"arch\":{}}}",
        json_string(VERSION),
        json_string(env::consts::OS),
        json_string(env::consts::ARCH)
    )
}

fn run_process(args: Vec<OsString>) -> Result<(), String> {
    let mut iter = args.into_iter();
    let action = iter
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| "missing process action".to_string())?;

    match action.as_str() {
        "kill-tree" => run_process_kill_tree(iter.collect()),
        "spawn-detached" => run_process_spawn_detached(iter.collect()),
        "spawn-supervised" => run_process_spawn_supervised(iter.collect()),
        other => Err(format!("unknown process action: {other}")),
    }
}

fn run_process_kill_tree(args: Vec<OsString>) -> Result<(), String> {
    let mut iter = args.into_iter();
    let mut pid: Option<u32> = None;
    let mut force = false;
    while let Some(flag) = iter.next() {
        let flag = flag
            .into_string()
            .map_err(|_| "process flag must be utf-8".to_string())?;
        match flag.as_str() {
            "--pid" => {
                let raw = iter
                    .next()
                    .ok_or_else(|| "--pid requires a value".to_string())?
                    .into_string()
                    .map_err(|_| "--pid value must be utf-8".to_string())?;
                pid = Some(
                    raw.parse::<u32>()
                        .map_err(|_| format!("invalid --pid value: {raw}"))?,
                );
            }
            "--force" => force = true,
            other => return Err(format!("unknown process flag: {other}")),
        }
    }

    let pid = pid.ok_or_else(|| "--pid is required".to_string())?;
    let signaled = kill_process_tree(pid, force);
    println!("{{\"pid\":{},\"signaled\":{}}}", pid, signaled);
    Ok(())
}

fn run_process_spawn_detached(args: Vec<OsString>) -> Result<(), String> {
    let spec = parse_spawn_process_args(args)?;
    let pid = spawn_detached(&spec.command, &spec.args, spec.cwd.as_deref())?;
    println!("{{\"pid\":{pid}}}");
    Ok(())
}

fn run_process_spawn_supervised(args: Vec<OsString>) -> Result<(), String> {
    let spec = parse_spawn_process_args(args)?;
    spawn_supervised(&spec.command, &spec.args, spec.cwd.as_deref())
}

struct SpawnProcessSpec {
    cwd: Option<PathBuf>,
    command: String,
    args: Vec<String>,
}

fn parse_spawn_process_args(args: Vec<OsString>) -> Result<SpawnProcessSpec, String> {
    let mut iter = args.into_iter();
    let mut cwd: Option<PathBuf> = None;
    let mut command: Option<String> = None;
    let mut command_args: Vec<String> = Vec::new();

    while let Some(flag) = iter.next() {
        let flag = flag
            .into_string()
            .map_err(|_| "process flag must be utf-8".to_string())?;
        let mut value = || -> Result<String, String> {
            iter.next()
                .ok_or_else(|| format!("{flag} requires a value"))?
                .into_string()
                .map_err(|_| format!("{flag} value must be utf-8"))
        };
        match flag.as_str() {
            "--cwd" => cwd = Some(PathBuf::from(value()?)),
            "--command" => command = Some(value()?),
            "--arg" => command_args.push(value()?),
            other => return Err(format!("unknown process flag: {other}")),
        }
    }

    Ok(SpawnProcessSpec {
        cwd,
        command: command.ok_or_else(|| "--command is required".to_string())?,
        args: command_args,
    })
}

fn run_pty(args: Vec<OsString>) -> Result<(), String> {
    let mut iter = args.into_iter();
    let action = iter
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| "missing pty action".to_string())?;

    match action.as_str() {
        "spawn" => run_pty_spawn(iter.collect()),
        other => Err(format!("unknown pty action: {other}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PtySpawnSpec {
    cwd: Option<PathBuf>,
    command: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
}

fn parse_pty_spawn_args(args: Vec<OsString>) -> Result<PtySpawnSpec, String> {
    let mut iter = args.into_iter();
    let mut cwd: Option<PathBuf> = None;
    let mut command: Option<String> = None;
    let mut command_args: Vec<String> = Vec::new();
    let mut cols: u16 = 80;
    let mut rows: u16 = 24;

    while let Some(flag) = iter.next() {
        let flag = flag
            .into_string()
            .map_err(|_| "pty flag must be utf-8".to_string())?;
        let mut value = || -> Result<String, String> {
            iter.next()
                .ok_or_else(|| format!("{flag} requires a value"))?
                .into_string()
                .map_err(|_| format!("{flag} value must be utf-8"))
        };
        match flag.as_str() {
            "--cwd" => cwd = Some(PathBuf::from(value()?)),
            "--command" => command = Some(value()?),
            "--arg" => command_args.push(value()?),
            "--cols" => cols = parse_pty_dimension("--cols", &value()?)?,
            "--rows" => rows = parse_pty_dimension("--rows", &value()?)?,
            other => return Err(format!("unknown pty flag: {other}")),
        }
    }

    Ok(PtySpawnSpec {
        cwd,
        command: command.ok_or_else(|| "--command is required".to_string())?,
        args: command_args,
        cols,
        rows,
    })
}

fn parse_pty_dimension(name: &str, raw: &str) -> Result<u16, String> {
    let value = raw
        .parse::<u16>()
        .map_err(|_| format!("invalid {name} value: {raw}"))?;
    if value == 0 {
        return Err(format!("{name} must be greater than 0"));
    }
    Ok(value)
}

fn run_pty_spawn(args: Vec<OsString>) -> Result<(), String> {
    let spec = parse_pty_spawn_args(args)?;
    spawn_pty(spec)
}

fn spawn_pty(spec: PtySpawnSpec) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(spec.cols, spec.rows))
        .map_err(|error| format!("failed to open pty: {error}"))?;

    let mut command = CommandBuilder::new(&spec.command);
    command.args(&spec.args);
    if let Some(cwd) = &spec.cwd {
        command.cwd(cwd);
    }

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("failed to spawn pty command {}: {error}", spec.command))?;
    let child_pid = child.process_id().unwrap_or(0);
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("failed to clone pty reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("failed to open pty writer: {error}"))?;
    let killer = child.clone_killer();
    let master = pair.master;

    thread::spawn(move || {
        let _ = pump_pty_output(&mut reader);
    });
    thread::spawn(move || {
        let _ = pump_pty_input(writer, master, killer);
    });

    println!("ready\t{child_pid}");
    io::stdout()
        .flush()
        .map_err(|error| format!("failed to flush pty ready event: {error}"))?;

    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for pty child: {error}"))?;
    println!(
        "exit\t{}\t{}",
        status.exit_code(),
        status.signal().unwrap_or("")
    );
    io::stdout()
        .flush()
        .map_err(|error| format!("failed to flush pty exit event: {error}"))?;
    std::process::exit(i32::try_from(status.exit_code()).unwrap_or(1));
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn pump_pty_output(reader: &mut dyn Read) -> Result<(), String> {
    let mut buffer = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("failed to read pty output: {error}"))?;
        if count == 0 {
            return Ok(());
        }
        println!("data\t{}", base64_encode(&buffer[..count]));
        io::stdout()
            .flush()
            .map_err(|error| format!("failed to flush pty output: {error}"))?;
    }
}

fn pump_pty_input(
    mut writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    mut killer: Box<dyn ChildKiller + Send + Sync>,
) -> Result<(), String> {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("failed to read pty command: {error}"))?;
        if !handle_pty_command(&line, &mut *writer, &*master, &mut *killer)? {
            return Ok(());
        }
    }
    let _ = killer.kill();
    Ok(())
}

fn handle_pty_command(
    line: &str,
    writer: &mut dyn Write,
    master: &dyn MasterPty,
    killer: &mut dyn ChildKiller,
) -> Result<bool, String> {
    let mut parts = line.split('\t');
    match parts.next().unwrap_or("") {
        "write" => {
            let data = parts
                .next()
                .ok_or_else(|| "write command requires data".to_string())?;
            let bytes = base64_decode(data)?;
            writer
                .write_all(&bytes)
                .map_err(|error| format!("failed to write pty input: {error}"))?;
            writer
                .flush()
                .map_err(|error| format!("failed to flush pty input: {error}"))?;
            Ok(true)
        }
        "resize" => {
            let cols = parse_pty_dimension(
                "cols",
                parts
                    .next()
                    .ok_or_else(|| "resize command requires cols".to_string())?,
            )?;
            let rows = parse_pty_dimension(
                "rows",
                parts
                    .next()
                    .ok_or_else(|| "resize command requires rows".to_string())?,
            )?;
            master
                .resize(pty_size(cols, rows))
                .map_err(|error| format!("failed to resize pty: {error}"))?;
            Ok(true)
        }
        "close" => {
            let _ = killer.kill();
            Ok(false)
        }
        "" => Ok(true),
        other => Err(format!("unknown pty command: {other}")),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectoryEntryJson {
    name: String,
    entry_type: &'static str,
    size: Option<u64>,
    modified: Option<u128>,
    is_git_repo: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TreeNodeJson {
    name: String,
    path: String,
    entry_type: &'static str,
    size: u64,
    modified: Option<u128>,
    children: Option<Vec<TreeNodeJson>>,
}

fn run_fs(args: Vec<OsString>) -> Result<(), String> {
    let mut iter = args.into_iter();
    let action = iter
        .next()
        .and_then(|value| value.into_string().ok())
        .ok_or_else(|| "missing fs action".to_string())?;
    if action != "list-dir" && action != "tree" && action != "read-file" && action != "write-file" {
        return Err(format!("unknown fs action: {action}"));
    }

    let mut root: Option<PathBuf> = None;
    let mut path: Option<PathBuf> = None;
    let mut include_git = false;
    let mut hide_dot = false;
    let mut content: Option<String> = None;
    let mut expected_hash: Option<String> = None;
    let mut max_depth: usize = 0;

    while let Some(flag) = iter.next() {
        let flag = flag
            .into_string()
            .map_err(|_| "fs flag must be utf-8".to_string())?;
        let mut value = || -> Result<String, String> {
            iter.next()
                .ok_or_else(|| format!("{flag} requires a value"))?
                .into_string()
                .map_err(|_| format!("{flag} value must be utf-8"))
        };
        match flag.as_str() {
            "--root" => root = Some(PathBuf::from(value()?)),
            "--path" => path = Some(PathBuf::from(value()?)),
            "--include-git" => include_git = true,
            "--hide-dot" => hide_dot = true,
            "--content" => content = Some(value()?),
            "--expected-hash" => expected_hash = Some(value()?),
            "--max-depth" => {
                let raw = value()?;
                max_depth = raw
                    .parse::<usize>()
                    .map_err(|_| format!("invalid --max-depth value: {raw}"))?;
            }
            other => return Err(format!("unknown fs flag: {other}")),
        }
    }

    let root = root.ok_or_else(|| "--root is required".to_string())?;
    let path = path.unwrap_or_else(|| PathBuf::from("."));
    if action == "read-file" {
        let content = read_file_base64(&root, &path)?;
        println!("{{\"success\":true,\"content\":{}}}", json_string(&content));
    } else if action == "tree" {
        let tree = directory_tree(&root, &path, max_depth)?;
        println!("{{\"success\":true,\"tree\":{}}}", tree_json(&tree));
    } else if action == "write-file" {
        let hash = write_file_base64(
            &root,
            &path,
            content.as_deref().unwrap_or(""),
            expected_hash.as_deref(),
        )?;
        println!("{{\"success\":true,\"hash\":{}}}", json_string(&hash));
    } else {
        let entries = list_directory(&root, &path, include_git, hide_dot)?;
        println!("{}", list_directory_json(&entries));
    }
    Ok(())
}

fn resolve_scoped_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("root {} is not accessible: {error}", root.to_string_lossy()))?;
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_root.join(path)
    };
    let canonical_target = candidate.canonicalize().map_err(|error| {
        format!(
            "path {} is not accessible: {error}",
            candidate.to_string_lossy()
        )
    })?;

    if canonical_target != canonical_root && !canonical_target.starts_with(&canonical_root) {
        return Err(format!(
            "access denied: path {} is outside root {}",
            canonical_target.to_string_lossy(),
            canonical_root.to_string_lossy()
        ));
    }

    Ok(canonical_target)
}

fn resolve_scoped_write_path(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("root {} is not accessible: {error}", root.to_string_lossy()))?;
    let candidate = if path.is_absolute() {
        path.to_path_buf()
    } else {
        canonical_root.join(path)
    };

    let target = if candidate.exists() {
        candidate.canonicalize().map_err(|error| {
            format!(
                "path {} is not accessible: {error}",
                candidate.to_string_lossy()
            )
        })?
    } else {
        let parent = candidate
            .parent()
            .ok_or_else(|| format!("path {} has no parent", candidate.to_string_lossy()))?;
        let file_name = candidate
            .file_name()
            .ok_or_else(|| format!("path {} has no file name", candidate.to_string_lossy()))?;
        parent
            .canonicalize()
            .map_err(|error| {
                format!(
                    "parent {} is not accessible: {error}",
                    parent.to_string_lossy()
                )
            })?
            .join(file_name)
    };

    if target != canonical_root && !target.starts_with(&canonical_root) {
        return Err(format!(
            "access denied: path {} is outside root {}",
            target.to_string_lossy(),
            canonical_root.to_string_lossy()
        ));
    }

    Ok(target)
}

fn list_directory(
    root: &Path,
    path: &Path,
    include_git: bool,
    hide_dot: bool,
) -> Result<Vec<DirectoryEntryJson>, String> {
    let target = resolve_scoped_path(root, path)?;
    let dir_metadata = fs::metadata(&target)
        .map_err(|error| format!("failed to stat {}: {error}", target.to_string_lossy()))?;
    if !dir_metadata.is_dir() {
        return Err("path is not a directory".to_string());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&target)
        .map_err(|error| format!("failed to list {}: {error}", target.to_string_lossy()))?
    {
        let entry = entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if hide_dot && name.starts_with('.') {
            continue;
        }

        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect {name}: {error}"))?;
        let entry_type = if file_type.is_dir() {
            "directory"
        } else if file_type.is_file() {
            "file"
        } else {
            "other"
        };

        let (size, modified) = if file_type.is_symlink() {
            (None, None)
        } else {
            match entry.metadata() {
                Ok(metadata) => (Some(metadata.len()), modified_ms(&metadata)),
                Err(_) => (None, None),
            }
        };

        let is_git_repo = if include_git && file_type.is_dir() {
            let git_path = entry.path().join(".git");
            Some(
                fs::metadata(git_path)
                    .map(|metadata| metadata.is_dir() || metadata.is_file())
                    .unwrap_or(false),
            )
        } else if include_git {
            Some(false)
        } else {
            None
        };

        entries.push(DirectoryEntryJson {
            name,
            entry_type,
            size,
            modified,
            is_git_repo,
        });
    }

    entries.sort_by(
        |a, b| match (a.entry_type == "directory", b.entry_type == "directory") {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        },
    );

    Ok(entries)
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u128> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn list_directory_json(entries: &[DirectoryEntryJson]) -> String {
    let entries_json = entries
        .iter()
        .map(|entry| {
            let mut fields = vec![
                format!("\"name\":{}", json_string(&entry.name)),
                format!("\"type\":{}", json_string(entry.entry_type)),
            ];
            if let Some(size) = entry.size {
                fields.push(format!("\"size\":{size}"));
            }
            if let Some(modified) = entry.modified {
                fields.push(format!("\"modified\":{modified}"));
            }
            if let Some(is_git_repo) = entry.is_git_repo {
                fields.push(format!("\"isGitRepo\":{is_git_repo}"));
            }
            format!("{{{}}}", fields.join(","))
        })
        .collect::<Vec<_>>()
        .join(",");
    format!("{{\"success\":true,\"entries\":[{entries_json}]}}")
}

fn directory_tree(root: &Path, path: &Path, max_depth: usize) -> Result<TreeNodeJson, String> {
    let target = resolve_scoped_path(root, path)?;
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| target.to_string_lossy().into_owned());
    build_tree_node(&target, name, 0, max_depth)
}

fn build_tree_node(
    path: &Path,
    name: String,
    current_depth: usize,
    max_depth: usize,
) -> Result<TreeNodeJson, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("failed to stat {}: {error}", path.to_string_lossy()))?;
    let is_dir = metadata.is_dir();
    let mut node = TreeNodeJson {
        name,
        path: path.to_string_lossy().into_owned(),
        entry_type: if is_dir { "directory" } else { "file" },
        size: metadata.len(),
        modified: modified_ms(&metadata),
        children: None,
    };

    if is_dir && current_depth < max_depth {
        let mut children = Vec::new();
        for entry in fs::read_dir(path)
            .map_err(|error| format!("failed to list {}: {error}", path.to_string_lossy()))?
        {
            let entry =
                entry.map_err(|error| format!("failed to read directory entry: {error}"))?;
            let file_type = entry.file_type().map_err(|error| {
                format!(
                    "failed to inspect {}: {error}",
                    entry.file_name().to_string_lossy()
                )
            })?;
            if file_type.is_symlink() {
                continue;
            }
            let child_name = entry.file_name().to_string_lossy().into_owned();
            if let Ok(child) =
                build_tree_node(&entry.path(), child_name, current_depth + 1, max_depth)
            {
                children.push(child);
            }
        }
        children.sort_by(
            |a, b| match (a.entry_type == "directory", b.entry_type == "directory") {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.cmp(&b.name),
            },
        );
        node.children = Some(children);
    }

    Ok(node)
}

fn tree_json(node: &TreeNodeJson) -> String {
    let mut fields = vec![
        format!("\"name\":{}", json_string(&node.name)),
        format!("\"path\":{}", json_string(&node.path)),
        format!("\"type\":{}", json_string(node.entry_type)),
        format!("\"size\":{}", node.size),
    ];
    if let Some(modified) = node.modified {
        fields.push(format!("\"modified\":{modified}"));
    }
    if let Some(children) = &node.children {
        fields.push(format!(
            "\"children\":[{}]",
            children.iter().map(tree_json).collect::<Vec<_>>().join(",")
        ));
    }
    format!("{{{}}}", fields.join(","))
}

fn read_file_base64(root: &Path, path: &Path) -> Result<String, String> {
    let target = resolve_scoped_path(root, path)?;
    let metadata = fs::metadata(&target)
        .map_err(|error| format!("failed to stat {}: {error}", target.to_string_lossy()))?;
    if !metadata.is_file() {
        return Err("path is not a file".to_string());
    }
    let bytes = fs::read(&target)
        .map_err(|error| format!("failed to read {}: {error}", target.to_string_lossy()))?;
    Ok(base64_encode(&bytes))
}

fn write_file_base64(
    root: &Path,
    path: &Path,
    content: &str,
    expected_hash: Option<&str>,
) -> Result<String, String> {
    let target = resolve_scoped_write_path(root, path)?;
    let bytes = base64_decode(content)?;

    if let Some(expected_hash) = expected_hash {
        let existing = match fs::read(&target) {
            Ok(existing) => existing,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err("File does not exist but hash was provided".to_string());
            }
            Err(error) => {
                return Err(format!(
                    "failed to read {}: {error}",
                    target.to_string_lossy()
                ));
            }
        };
        let existing_hash = sha256_hex(&existing);
        if existing_hash != expected_hash {
            return Err(format!(
                "File hash mismatch. Expected: {expected_hash}, Actual: {existing_hash}"
            ));
        }
    } else if target.exists() {
        return Err("File already exists but was expected to be new".to_string());
    }

    fs::write(&target, &bytes)
        .map_err(|error| format!("failed to write {}: {error}", target.to_string_lossy()))?;
    Ok(sha256_hex(&bytes))
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(value: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|error| format!("invalid base64 content: {error}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn run_service(args: Vec<OsString>) -> Result<(), String> {
    let options = parse_service_args(args)?;
    match options.action {
        ServiceAction::Install => install_service(&options),
        ServiceAction::Uninstall => uninstall_service(&options.paths),
        ServiceAction::Status => status_service(&options.paths),
        ServiceAction::RenderLaunchd => {
            println!(
                "{}",
                render_launchd(&options.spec, &runner_log_path(&options.paths))
            );
            Ok(())
        }
        ServiceAction::RenderSystemd => {
            println!("{}", render_systemd(&options.spec));
            Ok(())
        }
    }
}

fn parse_service_args(args: Vec<OsString>) -> Result<ServiceOptions, String> {
    let mut iter = args.into_iter();
    let action = match iter
        .next()
        .and_then(|value| value.into_string().ok())
        .as_deref()
    {
        Some("install") => ServiceAction::Install,
        Some("uninstall") => ServiceAction::Uninstall,
        Some("status") => ServiceAction::Status,
        Some("render-launchd") => ServiceAction::RenderLaunchd,
        Some("render-systemd") => ServiceAction::RenderSystemd,
        Some(other) => return Err(format!("unknown service action: {other}")),
        None => return Err("missing service action".to_string()),
    };

    let mut command: Option<String> = None;
    let mut service_args: Vec<String> = Vec::new();
    let mut home: Option<PathBuf> = None;
    let mut logs_dir: Option<PathBuf> = None;

    while let Some(flag) = iter.next() {
        let flag = flag
            .into_string()
            .map_err(|_| "service flag must be utf-8".to_string())?;
        let mut value = || -> Result<String, String> {
            iter.next()
                .ok_or_else(|| format!("{flag} requires a value"))?
                .into_string()
                .map_err(|_| format!("{flag} value must be utf-8"))
        };
        match flag.as_str() {
            "--command" => command = Some(value()?),
            "--arg" => service_args.push(value()?),
            "--home" => home = Some(PathBuf::from(value()?)),
            "--logs-dir" => logs_dir = Some(PathBuf::from(value()?)),
            other => return Err(format!("unknown service flag: {other}")),
        }
    }

    let home = home.unwrap_or_else(resolve_home_dir);
    let logs_dir = logs_dir.unwrap_or_else(|| home.join(".hapi").join("logs"));
    let command = command.unwrap_or_else(|| "hapi".to_string());
    let args = if service_args.is_empty() {
        vec!["runner".into(), "start-sync".into()]
    } else {
        service_args
    };

    Ok(ServiceOptions {
        action,
        spec: ServiceSpec {
            command,
            args,
            env: service_environment(&home),
        },
        paths: ServicePaths { home, logs_dir },
    })
}

fn resolve_home_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn service_environment(home: &PathBuf) -> Vec<(String, String)> {
    let mut envs = vec![
        ("HAPI_DISABLE_VERSION_HANDOFF".to_string(), "1".to_string()),
        ("HOME".to_string(), home.to_string_lossy().into_owned()),
    ];

    for key in ["USER", "SHELL", "PATH", "HAPI_HOME"] {
        if let Ok(value) = env::var(key) {
            if !value.trim().is_empty() {
                envs.push((key.to_string(), value));
            }
        }
    }

    envs
}

fn launchd_path(paths: &ServicePaths) -> PathBuf {
    paths
        .home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist"))
}

fn systemd_path(paths: &ServicePaths) -> PathBuf {
    paths
        .home
        .join(".config")
        .join("systemd")
        .join("user")
        .join(SYSTEMD_UNIT)
}

fn runner_log_path(paths: &ServicePaths) -> PathBuf {
    paths.logs_dir.join("runner-service.log")
}

fn render_launchd(spec: &ServiceSpec, log_path: &PathBuf) -> String {
    let program_arguments = std::iter::once(&spec.command)
        .chain(spec.args.iter())
        .map(|arg| format!("        <string>{}</string>", xml_escape(arg)))
        .collect::<Vec<_>>()
        .join("\n");
    let environment = spec
        .env
        .iter()
        .map(|(key, value)| {
            format!(
                "        <key>{}</key>\n        <string>{}</string>",
                xml_escape(key),
                xml_escape(value)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
{program_arguments}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
{environment}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>{}</string>
    <key>StandardErrorPath</key>
    <string>{}</string>
</dict>
</plist>
"#,
        xml_escape(&log_path.to_string_lossy()),
        xml_escape(&log_path.to_string_lossy())
    )
}

fn render_systemd(spec: &ServiceSpec) -> String {
    let exec_start = std::iter::once(&spec.command)
        .chain(spec.args.iter())
        .map(|arg| systemd_exec_arg(arg))
        .collect::<Vec<_>>()
        .join(" ");
    let environment = spec
        .env
        .iter()
        .map(|(key, value)| format!("Environment={}", systemd_quote(&format!("{key}={value}"))))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        r#"[Unit]
Description=HAPI Runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
KillMode=process
ExecStart={exec_start}
Restart=on-failure
RestartSec=5
{environment}

[Install]
WantedBy=default.target
"#
    )
}

fn install_service(options: &ServiceOptions) -> Result<(), String> {
    match env::consts::OS {
        "macos" => {
            let path = launchd_path(&options.paths);
            let log_path = runner_log_path(&options.paths);
            create_parent_dir(&path)?;
            fs::create_dir_all(&options.paths.logs_dir)
                .map_err(|error| format_io("create logs dir", &options.paths.logs_dir, error))?;
            fs::write(&path, render_launchd(&options.spec, &log_path))
                .map_err(|error| format_io("write launchd plist", &path, error))?;
            let target = macos_user_target()?;
            let _ = run_external(
                "launchctl",
                &["bootout", &format!("{target}/{LAUNCHD_LABEL}")],
                true,
            )?;
            run_external(
                "launchctl",
                &["bootstrap", &target, &path.to_string_lossy()],
                false,
            )?;
            let _ = run_external(
                "launchctl",
                &["enable", &format!("{target}/{LAUNCHD_LABEL}")],
                true,
            )?;
            run_external(
                "launchctl",
                &["kickstart", "-k", &format!("{target}/{LAUNCHD_LABEL}")],
                false,
            )?;
            println!(
                "{{\"servicePath\":{}}}",
                json_string(&path.to_string_lossy())
            );
            Ok(())
        }
        "linux" => {
            let path = systemd_path(&options.paths);
            create_parent_dir(&path)?;
            fs::write(&path, render_systemd(&options.spec))
                .map_err(|error| format_io("write systemd unit", &path, error))?;
            run_external("systemctl", &["--user", "daemon-reload"], false)?;
            run_external(
                "systemctl",
                &["--user", "enable", "--now", SYSTEMD_UNIT],
                false,
            )?;
            println!(
                "{{\"servicePath\":{}}}",
                json_string(&path.to_string_lossy())
            );
            Ok(())
        }
        other => Err(format!(
            "runner auto-start service is not supported on {other} yet"
        )),
    }
}

fn uninstall_service(paths: &ServicePaths) -> Result<(), String> {
    match env::consts::OS {
        "macos" => {
            let path = launchd_path(paths);
            let target = macos_user_target()?;
            let _ = run_external(
                "launchctl",
                &["bootout", &format!("{target}/{LAUNCHD_LABEL}")],
                true,
            )?;
            let _ = fs::remove_file(&path);
            println!(
                "{{\"servicePath\":{}}}",
                json_string(&path.to_string_lossy())
            );
            Ok(())
        }
        "linux" => {
            let path = systemd_path(paths);
            let _ = run_external(
                "systemctl",
                &["--user", "disable", "--now", SYSTEMD_UNIT],
                true,
            )?;
            let _ = fs::remove_file(&path);
            let _ = run_external("systemctl", &["--user", "daemon-reload"], true)?;
            println!(
                "{{\"servicePath\":{}}}",
                json_string(&path.to_string_lossy())
            );
            Ok(())
        }
        other => Err(format!(
            "runner auto-start service is not supported on {other} yet"
        )),
    }
}

fn status_service(paths: &ServicePaths) -> Result<(), String> {
    match env::consts::OS {
        "macos" => {
            let path = launchd_path(paths);
            let status = if path.exists() {
                let target = macos_user_target()?;
                let output = run_external(
                    "launchctl",
                    &["print", &format!("{target}/{LAUNCHD_LABEL}")],
                    true,
                )?;
                if output.trim().is_empty() {
                    format!(
                        "Runner auto-start service is installed ({})",
                        path.to_string_lossy()
                    )
                } else {
                    output
                }
            } else {
                format!(
                    "Runner auto-start service is not installed ({})",
                    path.to_string_lossy()
                )
            };
            println!(
                "{{\"servicePath\":{},\"status\":{}}}",
                json_string(&path.to_string_lossy()),
                json_string(&status)
            );
            Ok(())
        }
        "linux" => {
            let path = systemd_path(paths);
            let status = if path.exists() {
                let output = run_external(
                    "systemctl",
                    &["--user", "status", SYSTEMD_UNIT, "--no-pager"],
                    true,
                )?;
                if output.trim().is_empty() {
                    format!(
                        "Runner auto-start service is installed ({})",
                        path.to_string_lossy()
                    )
                } else {
                    output
                }
            } else {
                format!(
                    "Runner auto-start service is not installed ({})",
                    path.to_string_lossy()
                )
            };
            println!(
                "{{\"servicePath\":{},\"status\":{}}}",
                json_string(&path.to_string_lossy()),
                json_string(&status)
            );
            Ok(())
        }
        other => {
            let status = format!("Runner auto-start service is not supported on {other} yet");
            println!(
                "{{\"servicePath\":\"\",\"status\":{}}}",
                json_string(&status)
            );
            Ok(())
        }
    }
}

fn spawn_detached(command: &str, args: &[String], cwd: Option<&Path>) -> Result<u32, String> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: pre_exec runs in the child just before exec; setsid has no Rust wrapper.
        unsafe {
            cmd.pre_exec(|| {
                if setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x00000008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }

    let child = cmd
        .spawn()
        .map_err(|error| format!("failed to spawn {command}: {error}"))?;
    Ok(child.id())
}

fn spawn_supervised(command: &str, args: &[String], cwd: Option<&Path>) -> Result<(), String> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: pre_exec runs in the child just before exec; setsid has no Rust wrapper.
        unsafe {
            cmd.pre_exec(|| {
                if setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    let mut child = cmd
        .spawn()
        .map_err(|error| format!("failed to spawn {command}: {error}"))?;
    println!("{{\"pid\":{}}}", child.id());
    io::stdout()
        .flush()
        .map_err(|error| format!("failed to flush child pid: {error}"))?;

    if let Some(mut stderr) = child.stderr.take() {
        let _ = io::copy(&mut stderr, &mut io::stderr());
    }

    let status = child
        .wait()
        .map_err(|error| format!("failed to wait for child {}: {error}", child.id()))?;
    std::process::exit(status.code().unwrap_or(1));
}

#[cfg(unix)]
unsafe extern "C" {
    fn setsid() -> i32;
}

fn kill_process_tree(pid: u32, force: bool) -> bool {
    if pid == 0 {
        return false;
    }

    #[cfg(windows)]
    {
        return kill_process_tree_windows(pid, force);
    }

    #[cfg(unix)]
    {
        let pairs = read_process_pairs();
        let pids = collect_process_tree(pid, &pairs);
        let signal = if force { 9 } else { 15 };
        for child_pid in &pids {
            let _ = signal_pid(*child_pid, signal);
        }

        wait_for_process_to_die(pid, 2_000);
        if !force && process_alive(pid) {
            for child_pid in &pids {
                let _ = signal_pid(*child_pid, 9);
            }
            wait_for_process_to_die(pid, 1_000);
        }
        true
    }
}

#[cfg(windows)]
fn kill_process_tree_windows(pid: u32, force: bool) -> bool {
    let mut args = vec!["/T".to_string(), "/PID".to_string(), pid.to_string()];
    if force {
        args.insert(0, "/F".to_string());
    }
    Command::new("taskkill")
        .args(args)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn read_process_pairs() -> Vec<(u32, u32)> {
    let output = Command::new("ps").args(["-axo", "pid=,ppid="]).output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse::<u32>().ok()?;
            let ppid = parts.next()?.parse::<u32>().ok()?;
            Some((pid, ppid))
        })
        .collect()
}

#[cfg(unix)]
fn collect_process_tree(root: u32, pairs: &[(u32, u32)]) -> Vec<u32> {
    fn visit(pid: u32, pairs: &[(u32, u32)], out: &mut Vec<u32>) {
        for (child, _) in pairs.iter().copied().filter(|(_, parent)| *parent == pid) {
            visit(child, pairs, out);
        }
        out.push(pid);
    }

    let mut pids = Vec::new();
    visit(root, pairs, &mut pids);
    pids
}

#[cfg(unix)]
unsafe extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

#[cfg(unix)]
fn signal_pid(pid: u32, signal: i32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: kill(2) is called with a plain PID and signal number.
    unsafe { kill(pid, signal) == 0 }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    signal_pid(pid, 0)
}

#[cfg(unix)]
fn wait_for_process_to_die(pid: u32, max_wait_ms: u64) {
    let mut waited = 0;
    while process_alive(pid) && waited < max_wait_ms {
        std::thread::sleep(std::time::Duration::from_millis(20));
        waited += 20;
    }
}

fn create_parent_dir(path: &PathBuf) -> Result<(), String> {
    match path.parent() {
        Some(parent) => fs::create_dir_all(parent)
            .map_err(|error| format_io("create parent dir", &PathBuf::from(parent), error)),
        None => Ok(()),
    }
}

fn macos_user_target() -> Result<String, String> {
    let output = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|error| format!("id -u failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "id -u failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() {
        return Err("id -u returned empty uid".to_string());
    }
    Ok(format!("gui/{uid}"))
}

fn run_external(command: &str, args: &[&str], allow_failure: bool) -> Result<String, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|error| format!("{} failed to start: {error}", command_text(command, args)))?;
    let text = [
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ]
    .into_iter()
    .filter(|part| !part.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n")
    .trim()
    .to_string();

    if !output.status.success() && !allow_failure {
        return Err(format!(
            "{} failed{}",
            command_text(command, args),
            if text.is_empty() {
                String::new()
            } else {
                format!(":\n{text}")
            }
        ));
    }

    Ok(text)
}

fn command_text(command: &str, args: &[&str]) -> String {
    std::iter::once(command)
        .chain(args.iter().copied())
        .collect::<Vec<_>>()
        .join(" ")
}

fn format_io(action: &str, path: &PathBuf, error: io::Error) -> String {
    format!("{action} {} failed: {error}", path.to_string_lossy())
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn systemd_quote(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
    )
}

fn systemd_exec_arg(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "_@%+=:,./-".contains(ch))
    {
        value.to_string()
    } else {
        systemd_quote(value)
    }
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            ch if ch.is_control() => out.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> ServiceSpec {
        ServiceSpec {
            command: "/usr/local/bin/hapi".into(),
            args: vec![
                "runner".into(),
                "start-sync".into(),
                "--workspace-root".into(),
                "/tmp/a b & c".into(),
            ],
            env: vec![
                ("HAPI_DISABLE_VERSION_HANDOFF".into(), "1".into()),
                ("HAPI_HOME".into(), "/Users/me/.hapi".into()),
            ],
        }
    }

    #[test]
    fn launchd_escapes_arguments_and_env() {
        let plist = render_launchd(
            &spec(),
            &PathBuf::from("/Users/me/.hapi/logs/runner & service.log"),
        );
        assert!(plist.contains("<string>com.hapi.runner</string>"));
        assert!(plist.contains("<key>SuccessfulExit</key>"));
        assert!(plist.contains("<string>/tmp/a b &amp; c</string>"));
        assert!(plist.contains("<string>/Users/me/.hapi/logs/runner &amp; service.log</string>"));
        assert!(plist.contains("<key>HAPI_DISABLE_VERSION_HANDOFF</key>"));
    }

    #[test]
    fn systemd_quotes_spaces_and_dollars() {
        let unit = render_systemd(&ServiceSpec {
            args: vec![
                "runner".into(),
                "start-sync".into(),
                "--workspace-root".into(),
                "/tmp/a b/$c".into(),
            ],
            ..spec()
        });
        assert!(unit.contains("KillMode=process"));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains(
            "ExecStart=/usr/local/bin/hapi runner start-sync --workspace-root \"/tmp/a b/\\$c\""
        ));
        assert!(unit.contains("Environment=\"HAPI_HOME=/Users/me/.hapi\""));
    }

    #[test]
    fn json_string_escapes_control_chars() {
        assert_eq!(json_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
    }

    #[test]
    fn doctor_reports_version_and_platform() {
        let report = doctor_json();
        assert!(report.contains("\"name\":\"hapi-local\""));
        assert!(report.contains(&format!("\"version\":{}", json_string(VERSION))));
        assert!(report.contains(&format!("\"os\":{}", json_string(env::consts::OS))));
    }

    #[cfg(unix)]
    #[test]
    fn collect_process_tree_returns_children_before_parent() {
        let pairs = vec![(2, 1), (3, 2), (4, 1), (9, 8)];
        assert_eq!(collect_process_tree(1, &pairs), vec![3, 2, 4, 1]);
    }

    #[test]
    fn list_directory_sorts_dirs_first_and_marks_git() {
        let root = temp_root("hapi-local-list");
        fs::create_dir_all(root.join("src/.git")).unwrap();
        fs::write(root.join("README.md"), "ok").unwrap();

        let entries = list_directory(&root, Path::new("."), true, false).unwrap();
        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["src", "README.md"]);
        assert_eq!(entries[0].entry_type, "directory");
        assert_eq!(entries[0].is_git_repo, Some(true));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scoped_path_rejects_parent_escape() {
        let root = temp_root("hapi-local-scope");
        let error = resolve_scoped_path(&root, Path::new("..")).unwrap_err();
        assert!(error.contains("outside root"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn read_file_returns_base64() {
        let root = temp_root("hapi-local-read");
        fs::write(root.join("note.txt"), b"hello").unwrap();

        let content = read_file_base64(&root, Path::new("note.txt")).unwrap();

        assert_eq!(content, "aGVsbG8=");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn base64_encode_handles_padding() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }

    #[test]
    fn write_file_creates_new_file_and_returns_hash() {
        let root = temp_root("hapi-local-write-new");

        let hash = write_file_base64(&root, Path::new("note.txt"), "aGk=", None).unwrap();

        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"hi");
        assert_eq!(
            hash,
            "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_file_checks_expected_hash() {
        let root = temp_root("hapi-local-write-hash");
        fs::write(root.join("note.txt"), b"old").unwrap();

        let hash = sha256_hex(b"old");
        let next_hash =
            write_file_base64(&root, Path::new("note.txt"), "bmV3", Some(&hash)).unwrap();

        assert_eq!(fs::read(root.join("note.txt")).unwrap(), b"new");
        assert_eq!(next_hash, sha256_hex(b"new"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_file_rejects_existing_without_hash() {
        let root = temp_root("hapi-local-write-exists");
        fs::write(root.join("note.txt"), b"old").unwrap();

        let error = write_file_base64(&root, Path::new("note.txt"), "bmV3", None).unwrap_err();

        assert_eq!(error, "File already exists but was expected to be new");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_tree_respects_max_depth_and_sorts() {
        let root = temp_root("hapi-local-tree");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/main.ts"), "ok").unwrap();
        fs::write(root.join("README.md"), "ok").unwrap();

        let tree = directory_tree(&root, Path::new("."), 1).unwrap();
        let children = tree.children.unwrap();
        let names = children
            .iter()
            .map(|node| node.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["src", "README.md"]);
        assert_eq!(children[0].entry_type, "directory");
        assert!(children[0].children.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn spawn_detached_rejects_missing_command() {
        let error = spawn_detached("/definitely/not/hapi-local-test", &[], None).unwrap_err();
        assert!(error.contains("failed to spawn"));
    }

    #[test]
    fn pty_spawn_args_parse_dimensions_and_args() {
        let spec = parse_pty_spawn_args(vec![
            OsString::from("--cwd"),
            OsString::from("/tmp/work"),
            OsString::from("--cols"),
            OsString::from("120"),
            OsString::from("--rows"),
            OsString::from("40"),
            OsString::from("--command"),
            OsString::from("/bin/zsh"),
            OsString::from("--arg"),
            OsString::from("-l"),
        ])
        .unwrap();

        assert_eq!(spec.cwd, Some(PathBuf::from("/tmp/work")));
        assert_eq!(spec.command, "/bin/zsh");
        assert_eq!(spec.args, vec!["-l"]);
        assert_eq!(spec.cols, 120);
        assert_eq!(spec.rows, 40);
    }

    fn temp_root(prefix: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
