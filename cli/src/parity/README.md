# Claude remote wrapper wire contract

Run `bun run test:parity` from the repository root on Linux. Each scenario launches the CLI from this checkout against a loopback Socket.IO `/cli` hub, REST endpoints, and a fake runner control server. The wrapper launches the scripted Claude executable through `HAPI_CLAUDE_PATH`. The golden captures wire events and acknowledgements, agent invocations and stdin, and the messages decoded by the web client.

## Add or update a scenario

1. Copy `corpus/claude/plain-turn/` to a new scenario directory. Edit `scenario.json` to set wrapper arguments and script the hub actions. Edit `agent.jsonl` to match stdin and emit Claude stream events, one script step per line.
2. Give each hub action an `until` fence for the events and trailing acknowledgements it triggers. Use `release` and an agent `awaitMarker` to synchronize interleaved actions. Before disconnect or shutdown, use `settledAlive` to wait for the expected heartbeat on that connection.
3. Run `bun run parity:record <scenario-name>` and inspect the golden diff. Run the command again to check that the recording is identical, then run `bun run test:parity`. Omit the scenario name to re-record the full corpus.

The normalizer validates process IDs, paths, ports, and timestamps before replacing variable values. It preserves event order within each step and channel and compares the first and last volatile heartbeat on each connection.

Set `HAPI_PARITY_WRAPPER_BIN` to an executable to run a second wrapper against the same goldens. Relative paths resolve from the repository root. The executable receives the scenario's CLI arguments and environment.
