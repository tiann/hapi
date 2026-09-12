# Engineering notes

- ACP session config caches separate `mode` and `thought_level` domains. Only reconcile the thought-level cache when the requested value is advertised by that thought-level option; Copilot agent modes such as `plan` must not overwrite effort state.
- Copilot and Kimi ACP effort handlers register after session initialization. Web discovery must tolerate transient `handler-not-registered` responses until the remote session is ready.
