# Hub Go Contract Checks

Run local contract checks (static):

```
node test/contract-runner.ts
```

This validates:
- HTTP contracts have recordings.
- Socket contracts list both directions.
- SSE contracts are covered by recordings or samples.

Runtime recording is still manual (see `test/contracts/README.md`).
