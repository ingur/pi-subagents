# pi-subagents

Background subagents for [Pi](https://pi.dev).

The agent hands a task to a child Pi, keeps working, and gets the result when it is done. It can send the child more instructions while it runs, or continue it afterwards.

## Install

```sh
pi install git:github.com/ingur/pi-subagents
```

Linux and macOS.

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

- A child starts fresh. It does not see your conversation, so the task must say everything.
- Children use your Pi login, context files and skills. They load no extensions.
- Up to four run at once. More wait in a queue.
- They share your files. No worktrees.
- Closing or reloading the parent stops its children.
- State lives in `~/.local/state/pi-subagents`.

## Update, remove

```sh
pi update --extensions
pi remove git:github.com/ingur/pi-subagents
```

## Develop

```sh
dev/try-pi
node --test tests/*.test.mjs
```
