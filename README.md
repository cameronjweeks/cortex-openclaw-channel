# Cortex Channel Plugin for OpenClaw

Connects an [OpenClaw](https://github.com/openclaw-ai/openclaw) agent to
[Cortex](https://github.com/cameronjweeks/cortex-app) — a team chat platform
where multiple users can interact with AI bots in shared channels.

## What this does

The plugin runs inside the OpenClaw gateway and bridges it to Cortex:

- Opens a Socket.IO connection to `cortex-socket` (realtime relay) as the bot user
- Subscribes to `messages:new` events in channels the bot is a member of
- Dispatches each inbound message to the OpenClaw agent
- Emits rich AI status (`typing`, `thinking`, tool-call lifecycle) back to the channel
- Creates and completes channel tasks automatically as the bot works
- Downloads message attachments to local storage and injects the paths into agent context
- Persists in-flight task state so crashes can be recovered cleanly
- Re-keys the OpenClaw session whenever Cortex rotates (reset/compact) so context actually resets

```
┌────────────┐   Socket.IO   ┌───────────────┐   HTTP  ┌────────────┐
│ Cortex App │ ◄───────────► │ cortex-socket │ ──────► │ cortex-api │
└────────────┘               └───────────────┘         └────────────┘
                                     ▲
                                     │ Socket.IO
                                     │
                             ┌───────┴─────────┐
                             │ OpenClaw        │
                             │ cortex-channel  │
                             │ (this plugin)   │
                             └─────────────────┘
```

## Requirements

- OpenClaw `>= 2026.4.14` (earlier versions work but lack plugin-SDK alias resolution
  fixes needed for symlinked installs)
- A running Cortex deployment: `cortex-api`, `cortex-socket`, `cortex-app`
- A user row in the Cortex database with `is_ai = true` whose email matches the
  plugin's configured `botEmail`

## Installation

### From npm (recommended)

```bash
openclaw plugin install @cameronjweeks/cortex-channel
```

### From git

```bash
openclaw plugin install git+https://github.com/cameronjweeks/cortex-openclaw-channel.git
```

### Local development

```bash
git clone https://github.com/cameronjweeks/cortex-openclaw-channel.git
cd cortex-openclaw-channel
npm install
npm pack
openclaw plugin install ./cortex-channel-*.tgz
```

## Configuration

All required values can be supplied two ways. **There are no hardcoded defaults.**
If neither source provides a required value, the plugin logs a warning and skips
startup rather than silently authenticating as a default identity.

### Option A — OpenClaw config (preferred)

In `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "cortex": {
      "enabled": true,
      "apiUrl": "http://localhost:3201",
      "realtimeUrl": "http://localhost:3202",
      "jwtSecret": "<matches cortex-api JWT_SECRET>",
      "botEmail": "bot@example.com",
      "botName": "Bot"
    }
  }
}
```

### Option B — Environment variables

Useful for containerized / 12-factor deployments where the operator prefers to
keep secrets out of `openclaw.json`:

```bash
CORTEX_API_URL=http://localhost:3201
CORTEX_REALTIME_URL=http://localhost:3202
CORTEX_JWT_SECRET=<matches cortex-api JWT_SECRET>
CORTEX_BOT_EMAIL=bot@example.com
CORTEX_BOT_NAME=Bot
```

Values from `openclaw.json` take precedence over environment variables when
both are set.

### Required fields

| Field / env var | Description |
|---|---|
| `apiUrl` / `CORTEX_API_URL` | cortex-api base URL (e.g. `http://localhost:3201` or `https://<domain>/api`) |
| `realtimeUrl` / `CORTEX_REALTIME_URL` | cortex-socket base URL (Socket.IO) |
| `jwtSecret` / `CORTEX_JWT_SECRET` | Must match `JWT_SECRET` in cortex-api's env |
| `botEmail` / `CORTEX_BOT_EMAIL` | Must match the `email` of the `is_ai=true` user in the Cortex `users` table |
| `botName` / `CORTEX_BOT_NAME` | Display name used for `ai:status` events and JWT claims |

### Multi-account

To run multiple bots from a single OpenClaw gateway, provide an `accounts`
map in `channels.cortex`:

```json
{
  "channels": {
    "cortex": {
      "enabled": true,
      "accounts": {
        "alice": {
          "apiUrl": "https://cortex.example.com/api",
          "realtimeUrl": "https://cortex.example.com",
          "jwtSecret": "<shared secret>",
          "botEmail": "alice@example.com",
          "botName": "Alice"
        },
        "bob": {
          "apiUrl": "https://cortex.example.com/api",
          "realtimeUrl": "https://cortex.example.com",
          "jwtSecret": "<shared secret>",
          "botEmail": "bob@example.com",
          "botName": "Bob"
        }
      }
    }
  }
}
```

Environment variables are only consulted for the single default account (no
multi-account env-var scheme).

## How it works

### Inbound flow
1. User sends a message in a Cortex channel
2. `cortex-socket` broadcasts `messages:new`
3. Plugin filters out bot/system messages and skips empty payloads
4. Plugin fetches the active `session` from cortex-api, resolving both its
   `sessionKey` and any `summary` seeded by a prior session reset
5. If Cortex has rotated the session since last turn, the plugin starts a
   fresh OpenClaw session keyed off the new Cortex `sessionKey` and injects
   the summary into `UntrustedContext` so the bot picks up the thread
6. Plugin creates a channel task (visible in the Cortex UI) for the work unit
7. Plugin dispatches to the OpenClaw agent with full context
8. Agent's reply is routed back to Cortex via the Socket.IO `apiRequest.request`
   relay, which calls `POST /v1/chat/messages` server-side

### AI status events
During each turn, the plugin emits `ai:status` events on the channel:
- `working` — generic activity
- `thinking` — extended-reasoning model is in the reasoning phase
- `searching` / `browsing` / `reading` / `writing` — mapped from tool-call names
- `null` — clear the indicator

These are consumed by cortex-app's chat store to show the user what the bot
is doing in real time.

### Channel task lifecycle
The plugin creates a channel task when it starts processing a message and
updates it to `completed` or `cancelled` when the agent finishes. A
`TaskPersistenceManager` records in-flight tasks to disk with a 20-second
heartbeat, and on startup cleans up any orphaned tasks from a prior crash.

### Authentication
The plugin generates a JWT signed with `jwtSecret`, containing `{ email, name }`
claims. Cortex-api validates the JWT and treats the bot as a regular user with
`is_ai = true`.

## Troubleshooting

- **Plugin logs "missing required config, skipping"** — one of `jwtSecret`, `apiUrl`,
  `realtimeUrl`, `botEmail`, `botName` is unset in both `openclaw.json` and
  the `CORTEX_*` environment.
- **Bot connects but no replies** — make sure the bot's email exists in the
  Cortex `users` table with `is_ai = true`, and that the bot is a member of
  the channel.
- **Intermittent "Send failed: fetch failed"** — `cortex-socket` may not be
  reachable; check that it's running on `realtimeUrl`.
- **Status indicators never show** — cortex-app must be on a build that
  subscribes to `ai:status` events (the chat store at `src/lib/stores/chat.ts`).

## Source layout

```
src/
  channel.ts              — Plugin entry: WebSocket wiring, inbound handler,
                            outbound sendText, StatusManager, task lifecycle
  runtime.ts              — OpenClaw runtime context holder
  download-attachments.ts — Downloads message attachments into
                            ~/.openclaw/media/inbound/ and returns local paths
  task-persistence.ts     — Crash-safe in-flight task recorder with heartbeat
                            + orphan cleanup on startup
index.ts                  — Plugin registration (registerChannel)
openclaw.plugin.json      — Plugin manifest (id: cortex-channel)
```

## License

MIT
