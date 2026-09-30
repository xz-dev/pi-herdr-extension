# pi-herdr-extension

Keeps a [Herdr](https://herdr.dev) Pi pane `working` while sibling work is still running after the parent agent settles, such as async [pi-subagents](https://github.com/nicobailon/pi-subagents) runs.

Herdr's managed Pi integration reports only the parent agent loop. pi-subagents emits `herdr:busy` while async runs are alive, but the managed integration does not consume it, so the pane shows idle or done while children still run. See [herdrdev/herdr#3323](https://github.com/herdrdev/herdr/discussions/3323).

## How it works

This extension loads Herdr's installed integration (`~/.pi/agent/extensions/herdr-agent-state.ts`, or under `PI_CODING_AGENT_DIR`) and runs it unchanged. It remains the only `herdr:pi` reporter, so session identity, resume, sequencing, and future Herdr updates still come from Herdr.

The wrapper only adjusts the lifecycle the integration sees:

- `ctx.isIdle()` is false while any `herdr:busy` count is active.
- When busy work starts after the parent is idle, the integration receives `agent_start`.
- When the last busy work ends while the parent is idle, the integration receives `agent_settled`.
- Busy changes are evaluated on the next tick, so a lower-then-raise relabel does not flash idle.
- `herdr:blocked` signals raised before `session_start` are replayed instead of dropped.

State precedence stays `blocked > working > idle`.

## Install

Install the package, then stop Pi from auto-loading the managed file directly. Keep the file installed; this extension imports it.

```bash
pi install git:github.com/xz-dev/pi-herdr-extension
```

Add this to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["-extensions/herdr-agent-state.ts"]
}
```

`herdr integration install pi` can keep updating the managed file. If the file is missing, this extension does nothing.

## Test

```bash
npm test
```

The tests run the installed Herdr integration against a fake Herdr socket.

## License

MIT
