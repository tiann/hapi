# Local Development Notes

## Installation & Deployment

To build and install hapi from source (for development):

```bash
./deploy/linux/install.sh --build --name hapi
```

This script:
- Builds the project from source
- Performs atomic installation using `mv -f` to avoid "text file busy" errors
- Updates the binary's mtime to trigger hot-reload if runner service is active
- Creates systemd services for production use
- Has rollback capability if something goes wrong

### Installation Options

- `--build` - Build from source before installing
- `--name NAME` - Service name (default: hapi)
- `--path PATH` - Installation path (default: ~/.local/bin)
- `--skip-systemd` - Skip systemd service setup
- `--tailscale` - Setup Tailscale serve for remote access
- `--port PORT` - Port for Hapi server (default: 3006)
- `-y, --yes` - Skip confirmation prompts

### Hot Reload

If the runner service is active, the install script will trigger automatic reload:
- The script touches the binary's mtime after installation
- Runner detects the change within 60 seconds
- Monitor reload: `journalctl --user -u hapi-runner.service -f`

### Rollback

If an installation fails, you can rollback to the previous version (the script creates backups automatically).
