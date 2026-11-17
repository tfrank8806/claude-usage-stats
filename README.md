# usage-stats

A Claude Code plugin that shows your Claude usage while you work: a side pane, a status line entry, and a `/usage-stats` command.

## What it shows

- **Plan limits**: your 5-hour and weekly rate-limit windows as % used, with a bar and time until reset.
- **Estimated time to limit**: projects when each window reaches 100% from how fast it has climbed over the last hour, and says whether you'll hit it before it resets. Warns with a toast when the projection is under 30 minutes, or when a window passes 90%.
- **Models used**: turns, input, output and cache tokens per model, and each model's share of all tokens.
- **Context window**: how full the current context is.
- **This session**: cost so far and spend per hour, turns, and token totals.
- **History across sessions**: cost, turns, output tokens and session count for today, the last 7 and 30 days, and everything kept (up to 180 days); a 14-day daily chart with each day's peak rate-limit %; and per-model usage over the last 30 days. `/usage-stats history` prints the summary as text.
- **Across machines** (optional): point every machine at one synced folder and history adds them all up, with a per-machine breakdown. See [Combining machines](#combining-machines).

The status line shows a compact version, e.g. `5-hour 62% (full ~15:40) · Weekly 18% · ctx 31% · $1.20`.

### Limits

- Rate-limit figures (and so the time-to-limit estimate) only appear when Claude Code reports them, which is on a Claude subscription. Elsewhere the pane shows context, cost and tokens only.
- Token and model stats count main-conversation turns of the current session.
- History is kept per machine, in the plugin's own store file under your Claude Code config directory, unless you set a sync folder, and starts the day the plugin is installed. Each session writes only its own per-day record, so sessions running side by side never overwrite each other. Records older than 180 days are pruned. Only turns of the main conversation are counted; cost is the session's own total, so it includes subagents.
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

## Combining machines

Set the plugin's **Sync folder** option on each machine to a folder your machines share through Dropbox, iCloud Drive, OneDrive, Syncthing or similar, for example `~/Dropbox/claude-usage`. Optionally set **Machine name** so each one is labelled clearly (it defaults to the host name). Both can be set on the options screen shown when you install the plugin, or later in `/config`, where each is a row under the plugin. Changing them there reloads the plugin; no restart needed.

How it works:

- Each machine writes one file, `usage-<machine id>.json`, and only that machine ever writes it, so the sync service never sees two machines editing the same file.
- Every machine reads all the `usage-*.json` files and adds them up. Records are keyed by session id, so a session that turns up in two files (a renamed machine, a restored backup) is counted once, and conflicted copies are ignored.
- The file is rewritten at session start, at most every two minutes while you work, and when a session ends. Another machine's newest turns show once its file has synced.
- The pane's **By machine** section lists each machine's last-30-day usage and when its file was last written. A file that can't be read is named under **Sync problem**.

What it still can't see: claude.ai chats, the desktop and mobile chat apps, cloud sessions (unless the plugin is installed there and can reach the folder), and anything before the plugin was installed on a machine. The 5-hour and weekly limit bars come from Anthropic and already reflect all of your usage.

## Use

Run `/usage-stats` to open the pane. The status line entry updates after each turn.

## License

MIT
