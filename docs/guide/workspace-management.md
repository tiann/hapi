# Workspace management

HAPI can manage files and Git repositories on a connected runner machine. These operations are opt-in and always limited to the workspace roots configured for that runner.

## Enable a workspace

Start the runner with one or more workspace roots:

    hapi runner start --workspace-root ~/code --workspace-root /srv/projects

Open **Browse** in the web app and select a machine. Every file and Git operation must resolve inside one of that machine's configured roots. Workspace roots and nested .git metadata cannot be modified through the file manager.

## File controls

The **Files** tab supports:

- creating files and directories;
- copying and moving files or directories;
- permanently deleting selected files or directories after confirmation;
- choosing an existing or custom destination for copy and move operations;
- choosing a conflict policy: stop, replace, create a numbered copy, or skip;
- previewing and editing text files with stale-write protection;
- previewing supported images;
- uploading one file at a time to the current directory, up to 20 MiB;
- downloading individual files and ZIP archives of directories.

Copy and move operations preflight destinations before changing files. Uploads create a numbered copy when the destination name already exists, so they do not overwrite a host file by default. Long operations run as cancellable runner jobs and report progress in the web app. Directory archives preserve the selected root directory and empty directories.

## Git controls

The **Git** tab discovers the repository containing the current directory and supports:

- status, branch, upstream, ahead/behind, and remote inspection;
- staging and unstaging paths;
- conventional or custom commit messages;
- pushing to origin;
- adding or replacing the origin URL;
- cloning into the current directory;
- fetching remote refs, updating the current branch, and creating, switching, or deleting local and remote branches.

For GitHub clones, HAPI prefers authenticated gh repo clone when available and falls back to git clone. Local working-tree operations and pushes use Git. Configure Git or GitHub CLI credentials on the runner machine; HAPI never accepts credentials embedded in a remote URL.

## Security

- Workspace paths are canonicalized with realpath; symlink escapes are rejected.
- Git commands use fixed argument arrays, never shell command strings.
- Remote URLs containing inline credentials are rejected.
- Keep workspace roots narrow. Only paths within those roots can be listed or modified.
