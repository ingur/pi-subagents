# pi-subagents

Background subagents for [Pi](https://pi.dev).

The agent hands a task to a subagent, keeps working, and gets the result when it is done. It can send the subagent more instructions while it runs, or continue it afterwards.

## Install

```sh
pi install git:github.com/ingur/pi-subagents
```

Linux and macOS. Needs Pi 1.5 and Node 22.19 or newer.

## Use

Just ask: "review this in a subagent while we continue".

| Command | |
| --- | --- |
| `/subagents` | status |
| `/subagents result ID` | read a result |
| `/subagents stop ID` | cancel |
| `/subagents forget ID` | drop a finished or stuck one and free its slot |

Tools: `subagent_start`, `subagent_send`, `subagent_list`, `subagent_result`, `subagent_stop`.

## Good to know

- A subagent starts fresh. It does not see your conversation, so the task must say everything.
- Subagents use your Pi login, context files and skills. They load no extensions.
- Up to four run at once. More wait in a queue.
- They share your files. No worktrees.
- Quitting, `/reload`, `/new`, `/resume`, `/fork` and `/clone` stop running subagents.
- Each parent session keeps its subagents' transcripts, output and logs in `~/.local/state/pi-subagents` until `/subagents forget ID`. Removing the package leaves that folder behind.

## Update, remove

```sh
pi update --extensions
pi remove git:github.com/ingur/pi-subagents
```

## Develop

```sh
dev/try-pi
dev/smoke    # after a Pi update: runs one real subagent (one small model turn)
node --test tests/*.test.mjs
```
