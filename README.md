# usage-stats

A Claude Code plugin that shows your Claude usage while you work: a side pane, a status line entry, and a `/usage-stats` command.

## What it shows

- **Plan limits**: your 5-hour and weekly rate-limit windows as % used, with a bar and time until reset.
- **Estimated time to limit**: projects when each window reaches 100% from how fast it has climbed over the last hour, and says whether you'll hit it before it resets. Warns with a toast when the projection is under 30 minutes, or when a window passes 90%.
- **Models used**: turns, input, output and cache tokens per model, and each model's share of all tokens.
- **Context window**: how full the current context is.
- **This session**: cost so far and spend per hour, turns, and token totals.

The status line shows a compact version, e.g. `5-hour 62% (full ~15:40) · Weekly 18% · ctx 31% · $1.20`.

### Limits

- Rate-limit figures (and so the time-to-limit estimate) only appear when Claude Code reports them, which is on a Claude subscription. Elsewhere the pane shows context, cost and tokens only.
- Token and model stats count main-conversation turns of the current session.
- The estimate is a straight-line projection; it is rough until a few readings have come in, since readings arrive when a window moves a whole percentage point.

## Install

At the prompt of a terminal Claude Code session:

```
/plugin install usage-stats --marketplace tfrank8806/claude-usage-stats
```

Answer `y` to add the marketplace, then pick a scope (user scope runs it in every session).

From a shell:

```bash
claude plugin install usage-stats --marketplace tfrank8806/claude-usage-stats
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `tfrank8806/claude-usage-stats`, then Add plugin.

## Use

Run `/usage-stats` to open the pane. The status line entry updates after each turn.

## License

MIT
