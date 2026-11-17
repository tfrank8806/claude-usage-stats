# usage-stats

A Claude Code plugin that shows your Claude usage while you work: a side pane, a status line entry, and a `/usage-stats` command.

## What it shows

- **Plan limits**: your 5-hour and weekly rate-limit windows as % used, with a bar and time until reset.
- **Estimated time to limit**: projects when each window reaches 100% from how fast it has climbed over the last hour, and says whether you'll hit it before it resets. Warns with a toast when the projection is under 30 minutes, or when a window passes 90%.
- **Models used**: turns, input, output and cache tokens per model, and each model's share of all tokens.
- **Context window**: how full the current context is.
- **This session**: cost so far and spend per hour, turns, and token totals.
- **History across sessions**: cost, turns, output tokens and session count for today, the last 7 and 30 days, and everything kept (up to 180 days); a 14-day daily chart with each day's peak rate-limit %; and per-model usage over the last 30 days. `/usage-stats history` prints the summary as text.
- **API-equivalent cost**: what your recorded Claude Code usage would cost at API prices this month (or billing period), so far and projected to its end. `/usage-stats value` prints it.
- **Subscription value** (optional): set your plan's monthly price and renewal day, and the pane also shows what your recorded usage would have cost at API prices this billing period, as a multiple of the plan, projected to the period's end, with the day it breaks even. `/usage-stats value` prints it. See [Subscription value](#subscription-value).
- **Across machines** (optional): point every machine at one synced folder and history adds them all up, with a per-machine breakdown. See [Combining machines](#combining-machines).

While a session is open, the pane and status line refresh every minute on their own, limit countdowns, cost and other machines' usage included, with no reply or command needed.

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
- The folder is read and this machine's file written at session start, at most every two minutes while a session is open (even an idle one), and when a session ends. An idle machine skips the write when nothing changed, but rewrites its file at least every 30 minutes so the others see it is alive. Another machine's newest turns show within a couple of minutes of reaching the folder.
- The pane's **By machine** section lists each machine's last-30-day usage and when its file was last written. A file that can't be read is named under **Sync problem**.

What it still can't see: claude.ai chats, the desktop and mobile chat apps, cloud sessions (unless the plugin is installed there and can reach the folder), and anything before the plugin was installed on a machine. The 5-hour and weekly limit bars come from Anthropic and already reflect all of your usage.

## Subscription value

Set two options (same way as the sync folder: `/plugin configure usage-stats@claude-usage-stats`, or `claude plugin configure … --values-stdin`):

- **subscriptionUsd**: what your plan costs per month, e.g. `20`, `100` or `200`.
- **billingDay**: the day of the month it renews (`1`–`31`; a short month renews on its last day).

```bash
echo '{"subscriptionUsd":200,"billingDay":5}' | claude plugin configure usage-stats@claude-usage-stats --values-stdin
```

Without them the pane still shows the **API-equivalent cost** for the calendar month (or for your billing period, if only `billingDay` is set), so far and projected, with a one-line reminder to add your price. With a price set it becomes **Subscription value** and shows, for the current billing period:

- **API-equivalent so far**: the cost Claude Code reports for your recorded usage (all synced machines), and that as a multiple of the plan. Above 1.00×, the plan has cost you less than the same usage on the API would have.
- **Projected**: the period's pace so far carried to its last day.
- **Break-even**: the day spend reached the plan price, or the day it will at this pace.

### Other apps (estimated)

claude.ai, the desktop and mobile apps don't report usage to plugins, but on a Claude subscription the 5-hour and weekly limits are shared with them. The plugin learns roughly how many dollars of Claude Code cost move a limit one point, from readings minutes apart while you use Claude Code; within each limit window, the rise Claude Code doesn't explain is counted as **Other apps (estimated)** and shown on its own line, plus a total including it. It prefers the weekly window, falling back to the 5-hour one. Until it has seen 5 points of calibration it says "calibrating". Synced machines share their estimates and each window is counted once.

It is rough: models use limits at different rates, readings are coarse, and a window in which Claude Code made no request at all on any machine is never seen. It is never mixed into the measured figures.

Read it as an upper bound on value, with two caveats: the measured figures count Claude Code only (other apps appear only as the separate estimate above), and it prices usage you might not have bought at API rates (so it overstates what you'd actually spend without the plan). Days before the plugin was installed aren't counted; the pane says when the period is only partly recorded and paces on the recorded days.

## Keeping the plugin up to date

Claude Code doesn't auto-update third-party marketplaces unless you turn it on. To have new versions of this plugin installed automatically, add `"autoUpdate": true` to its marketplace entry in `~/.claude/settings.json` on each machine:

```json
{
  "extraKnownMarketplaces": {
    "claude-usage-stats": {
      "source": { "source": "github", "repo": "tfrank8806/claude-usage-stats" },
      "autoUpdate": true
    }
  }
}
```

Without it, update by hand: `claude plugin marketplace update claude-usage-stats && claude plugin update usage-stats@claude-usage-stats`, then restart Claude Code.

## Use

Run `/usage-stats` to open the pane. The status line entry updates after each turn.

## License

MIT
