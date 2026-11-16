# usage-stats

A Claude Code plugin that shows your Claude usage while you work: a side pane, a status line entry, and a `/usage-stats` command.

## What it shows

- **Plan limits**: your 5-hour and weekly rate-limit windows as % used, with a bar and time until reset.
- **Estimated time to limit**: projects when each window reaches 100% from how fast it has climbed over the last hour, and says whether you'll hit it before it resets. Warns with a toast when the projection is under 30 minutes, or when a window passes 90%.
- **Models used**: turns, input, output and cache tokens per model, and each model's share of all tokens.
- **Context window**: how full the current context is.
- **This session**: cost so far and spend per hour, turns, and token totals.
- **History across sessions**: cost, turns, output tokens and session count for today, the last 7 and 30 days, and everything kept (up to 180 days); a 14-day daily chart with each day's peak rate-limit %; and per-model usage over the last 30 days. `/usage-stats history` prints the summary as text.

The status line shows a compact version, e.g. `5-hour 62% (full ~15:40) · Weekly 18% · ctx 31% · $1.20`.

### Limits

- Rate-limit figures (and so the time-to-limit estimate) only appear when Claude Code reports them, which is on a Claude subscription. Elsewhere the pane shows context, cost and tokens only.
- Token and model stats count main-conversation turns of the current session.
- History is kept per machine, in the plugin's own store file under your Claude Code config directory, and starts the day the plugin is installed. Each session writes only its own per-day record, so sessions running side by side never overwrite each other. Records older than 180 days are pruned. Only turns of the main conversation are counted; cost is the session's own total, so it includes subagents.
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
