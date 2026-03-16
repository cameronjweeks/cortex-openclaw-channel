# Cortex Channel Plugin for OpenClaw

Connect your OpenClaw AI agent to [Cortex](https://github.com/cameronjweeks/cortex-app) — a team chat platform where multiple users can interact with AI bots in shared channels.

## What This Does

This plugin bridges OpenClaw and Cortex via Socket.IO:

1. Your OpenClaw agent connects to `cortex-realtime` as a bot user
2. When someone sends a message in a Cortex channel, the plugin receives it
3. The message is dispatched to your OpenClaw agent for processing
4. The agent's response is sent back to the Cortex channel in real-time

```
┌──────────┐    Socket.IO    ┌──────────────────┐    HTTP    ┌────────────┐
│  Cortex  │ ◄────────────► │ cortex-realtime   │ ────────► │ cortex-api │
│  App     │  (messages)     │ (WebSocket relay) │  (proxy)  │ (REST API) │
└──────────┘                 └──────────────────┘            └────────────┘
                                      ▲
                                      │ Socket.IO
                                      │
                              ┌───────┴────────┐
                              │   OpenClaw      │
                              │   (this plugin) │
                              └────────────────┘
```

## Prerequisites

- A running Cortex instance ([cortex-api](https://github.com/cameronjweeks/cortex-api), [cortex-realtime](https://github.com/cameronjweeks/cortex-socket), [cortex-app](https://github.com/cameronjweeks/cortex-app))
- A bot user created in Cortex (with `is_ai = true` in the users table)
- The bot registered on the [Bots page](https://github.com/cameronjweeks/cortex-app) in Cortex
- OpenClaw installed and running

## Installation

```bash
# Navigate to your OpenClaw extensions directory
cd ~/.openclaw/extensions

# Clone the plugin
git clone https://github.com/cameronjweeks/cortex-openclaw-channel.git cortex-channel

# Install dependencies
cd cortex-channel
npm install
```

## Configuration

Add the Cortex channel to your OpenClaw config (`~/.openclaw/openclaw.yaml`):

```yaml
channels:
  cortex:
    enabled: true
    apiUrl: "https://your-cortex-domain.com/api"     # cortex-api URL (via nginx)
    realtimeUrl: "https://your-cortex-domain.com"     # cortex-realtime URL (via nginx)
    jwtSecret: "your-jwt-secret-from-cortex-api-env"  # Must match cortex-api's JWT_SECRET
    botEmail: "bot@yourdomain.com"                     # The bot's email in Cortex users table
    botName: "YourBot"                                 # Display name
```

### Configuration Options

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `enabled` | No | `true` | Enable/disable the channel |
| `apiUrl` | Yes | `http://localhost:3201` | URL to cortex-api (or nginx `/api` proxy) |
| `realtimeUrl` | Yes | `http://localhost:3202` | URL to cortex-realtime (WebSocket) |
| `jwtSecret` | Yes | — | JWT secret matching cortex-api's `JWT_SECRET` env var |
| `botEmail` | Yes | — | Email of the bot user in Cortex |
| `botName` | No | `"Bob"` | Display name for the bot |

### Multi-Account Support

You can run multiple bots from the same OpenClaw instance:

```yaml
channels:
  cortex:
    enabled: true
    jwtSecret: "shared-secret"
    accounts:
      bot1:
        apiUrl: "https://cortex.example.com/api"
        realtimeUrl: "https://cortex.example.com"
        botEmail: "bot1@example.com"
        botName: "Alice"
      bot2:
        apiUrl: "https://cortex.example.com/api"
        realtimeUrl: "https://cortex.example.com"
        botEmail: "bot2@example.com"
        botName: "Charlie"
```

## How It Works

### Message Flow (Inbound)

1. User sends a message in a Cortex channel
2. `cortex-realtime` broadcasts `messages:new` via Socket.IO
3. This plugin receives the event, skips bot/system messages
4. Fetches the active session key from cortex-api (for conversation continuity)
5. Dispatches to the OpenClaw agent with full context (sender, channel, session)
6. Agent processes and replies via `outbound.sendText`

### Message Flow (Outbound)

1. OpenClaw agent generates a response
2. Plugin sends it via the Socket.IO `apiRequest.request` relay
3. `cortex-realtime` proxies to cortex-api's `POST /v1/chat/messages`
4. cortex-api saves to DB and returns broadcast signals
5. `cortex-realtime` broadcasts `messages:new` to all connected clients
6. Cortex App renders the bot's message in real-time

### Session Management

Each Cortex channel maps to an OpenClaw session key (`cortex-channel-{channelId}` or the active session key from the API). This means:

- Conversation context persists within a channel
- Session resets in Cortex create new OpenClaw sessions
- Multiple channels = multiple independent conversations

### Authentication

The plugin generates a JWT signed with the shared secret, containing the bot's email and name. This is the same auth mechanism used by human users logging into the Cortex App — the bot is treated as a regular user with `is_ai = true`.

## Bot Registration in Cortex

Your bot needs to be registered in Cortex for the [Bots management page](/bots) to work:

1. Create a user in the Cortex database with `is_ai = true`
2. Register the bot on the Bots page (or it auto-registers on first connection)
3. The bot owner controls who can interact with the bot via permissions

### Permissions

- **Admin** — Full control over bot settings and permissions
- **Interact** — Can add the bot to channels and chat with it
- **View** — Can see the bot exists but can't interact

## Troubleshooting

### Bot not connecting

- Check that `realtimeUrl` is correct and accessible
- Verify `jwtSecret` matches the `JWT_SECRET` in cortex-api's `.env`
- Check OpenClaw logs: `openclaw logs --tail`

### Bot not responding to messages

- Ensure the bot user exists in Cortex with the correct email
- Check that the bot is a member of the channel
- Verify `apiUrl` is accessible from the OpenClaw server

### Messages appear but no AI response

- Check OpenClaw agent logs for errors
- Verify the session key is valid
- Ensure the channel has `auto_invite_ai` enabled or the bot was manually added

## Development

```bash
# Clone and install
git clone https://github.com/cameronjweeks/cortex-openclaw-channel.git
cd cortex-openclaw-channel
npm install

# Link to OpenClaw extensions
ln -s $(pwd) ~/.openclaw/extensions/cortex-channel

# Restart OpenClaw to pick up the plugin
openclaw gateway restart
```

## License

MIT
