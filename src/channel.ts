/**
 * Cortex Chat Channel Plugin for OpenClaw.
 *
 * Connects to cortex-realtime via Socket.IO as Bob,
 * listens for messages, routes them through the agent,
 * and sends responses back via the same socket RPC
 * (so cortex-realtime handles DB + broadcast).
 */
import { getCortexRuntime } from "./runtime.js";
import { downloadAttachments } from "./download-attachments.js";

const CHANNEL_ID = "cortex";
const DEFAULT_ACCOUNT_ID = "default";

// ─── Shared socket + auth references ─────────────────
// The gateway.startAccount creates the socket connection + JWT.
// outbound.sendText uses the socket to send replies via RPC.
// The task-management tools (src/tools.ts) read cachedApiUrl / cachedJwtToken
// at execute time to authenticate their cortex-api calls.
let activeSocket: any = null;
let cachedApiUrl: string | null = null;
let cachedJwtToken: string | null = null;

// Accessors exposed to tools.ts (avoids a direct module-to-module closure).
export function __getCortexApiUrl(): string | null { return cachedApiUrl; }
export function __getCortexJwtToken(): string | null { return cachedJwtToken; }

// ─── Session Management ──────────────────────────────
// Maintain stable OpenClaw sessions per channel to prevent fragmentation
// Map: channelId -> { cortexSessionKey, openclawSessionKey, lastActivity }
const channelSessions = new Map<number, {
  cortexSessionKey: string;
  openclawSessionKey: string;
  lastActivity: number;
}>();

// Session timeout: 24 hours of inactivity forces a new session
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function getStableSessionKey(channelId: number, cortexSessionKey: string): string {
  const now = Date.now();
  const existing = channelSessions.get(channelId);

  // If cortex has rotated its session (e.g. user pressed "reset"), start a fresh
  // OpenClaw session so context is actually compacted — otherwise the bot would
  // keep the old conversation in context no matter how many times cortex reset.
  const cortexRotated = existing && existing.cortexSessionKey !== cortexSessionKey;
  const expired = existing && (now - existing.lastActivity) >= SESSION_TIMEOUT_MS;

  if (existing && !cortexRotated && !expired) {
    existing.lastActivity = now;
    channelSessions.set(channelId, existing);
    console.log(`[cortex-channel] Using stable session ${existing.openclawSessionKey} for channel ${channelId} (Cortex: ${cortexSessionKey})`);
    return existing.openclawSessionKey;
  }

  // Key off the cortex session key so OpenClaw sees a distinct session per
  // cortex reset. Fallback to legacy channel-scoped key if cortex didn't
  // provide one (shouldn't happen in normal operation).
  const openclawSessionKey = cortexSessionKey
    ? `openclaw-${cortexSessionKey}`
    : `cortex-channel-${channelId}`;
  channelSessions.set(channelId, {
    cortexSessionKey,
    openclawSessionKey,
    lastActivity: now,
  });

  const reason = cortexRotated ? 'cortex rotated' : (expired ? 'expired' : 'new');
  console.log(`[cortex-channel] Created OpenClaw session ${openclawSessionKey} for channel ${channelId} (${reason}, Cortex: ${cortexSessionKey})`);
  return openclawSessionKey;
}

// ─── Channel Task helpers (read-only for context injection) ───
//
// The bot manages the task list itself via the channel_tasks_*
// openclaw tools registered in src/tools.ts. This helper just pulls
// the current list so we can inject it into UntrustedContext on
// every inbound turn — the agent sees "here's what's already on the
// task list" and can decide to update an existing task rather than
// create a duplicate.

async function fetchChannelTasks(apiUrl: string, channelId: number, token: string): Promise<any[]> {
  try {
    const res = await fetch(`${apiUrl}/v1/chat/channels/${channelId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { tasks?: any[] };
    return data.tasks || [];
  } catch {
    return [];
  }
}

function formatTasksForContext(tasks: any[]): string | null {
  if (!tasks.length) return null;
  const lines = tasks.map((t: any) => {
    const icon = t.status === 'in_progress' ? '◉' : t.status === 'completed' ? '✓' : t.status === 'cancelled' ? '✕' : '○';
    return `- [${icon} ${t.status.replace('_', ' ')}] #${t.id}: ${t.label}`;
  });
  return `Channel Tasks (use channel_tasks_* tools to update):\n${lines.join('\n')}`;
}

// ─── Config helpers ──────────────────────────────────

function getChannelConfig(cfg: any): any {
  return cfg?.channels?.cortex ?? {};
}

/**
 * Resolve an account config by merging, in priority order:
 *   1. openclaw config (channels.cortex.accounts[id] or channels.cortex)
 *   2. environment variables (CORTEX_API_URL, CORTEX_REALTIME_URL,
 *      CORTEX_JWT_SECRET, CORTEX_BOT_EMAIL, CORTEX_BOT_NAME)
 *
 * There are no hardcoded defaults: if neither source provides a required
 * value, `isConfigured` will return false and the plugin will skip startup
 * for that account rather than silently authenticate as someone else.
 */
function getAccountConfig(cfg: any, accountId?: string | null): any {
  const channelCfg = getChannelConfig(cfg);
  const id = accountId || DEFAULT_ACCOUNT_ID;
  const account = channelCfg.accounts?.[id] ?? channelCfg;
  return {
    accountId: id,
    enabled: account.enabled !== false && channelCfg.enabled !== false,
    apiUrl: account.apiUrl || channelCfg.apiUrl || process.env.CORTEX_API_URL || "",
    realtimeUrl: account.realtimeUrl || channelCfg.realtimeUrl || process.env.CORTEX_REALTIME_URL || "",
    jwtSecret: account.jwtSecret || channelCfg.jwtSecret || process.env.CORTEX_JWT_SECRET || "",
    botEmail: account.botEmail || channelCfg.botEmail || process.env.CORTEX_BOT_EMAIL || "",
    botName: account.botName || channelCfg.botName || process.env.CORTEX_BOT_NAME || "",
  };
}

function listAccountIds(cfg: any): string[] {
  const channelCfg = getChannelConfig(cfg);
  if (channelCfg.accounts) return Object.keys(channelCfg.accounts);
  if (channelCfg.apiUrl || channelCfg.jwtSecret) return [DEFAULT_ACCOUNT_ID];
  // Env-var-only configuration is supported too (useful in containerized /
  // 12-factor deployments where ~/.openclaw/openclaw.json is minimal).
  if (process.env.CORTEX_JWT_SECRET || process.env.CORTEX_API_URL) return [DEFAULT_ACCOUNT_ID];
  return [];
}

// ─── Helpers ─────────────────────────────────────────

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => { onAbort?.(); resolve(); };
    if (!signal) return;
    if (signal.aborted) { complete(); return; }
    signal.addEventListener("abort", complete, { once: true });
  });
}

function extractChannelId(target: string): number {
  // target format: "cortex:channel:3" or "cortex:user@example.com" or just "3"
  const match = target.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Send a message via the socket.io apiRequest relay.
 * cortex-realtime proxies to cortex-api, handles DB insert + broadcast.
 */
function sendViaSocket(channelId: number, text: string, account?: any): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!activeSocket?.connected) {
      resolve({ ok: false, error: "Socket not connected" });
      return;
    }

    const apiUrl = account?.apiUrl;
    if (!apiUrl) {
      resolve({ ok: false, error: "cortex-channel: apiUrl not configured (set channels.cortex.apiUrl or CORTEX_API_URL)" });
      return;
    }
    let resolved = false;

    activeSocket.emit("apiRequest.request", {
      url: `${apiUrl}/v1/chat/messages`,
      params: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { channelId, content: text, contentType: "text" },
      },
    }, (res: any) => {
      if (resolved) return;
      resolved = true;
      if (res?.ok) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: res?.body?.error || `HTTP ${res?.status}` || "Unknown error" });
      }
    });

    // Timeout after 30s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: "API request timeout (30s)" });
      }
    }, 30000);
  });
}

// ─── Channel plugin ─────────────────────────────────

export const cortexPlugin = {
  id: CHANNEL_ID,

  meta: {
    id: CHANNEL_ID,
    label: "Cortex Chat",
    selectionLabel: "Cortex Chat (WebSocket)",
    detailLabel: "Cortex Chat",
    docsPath: "/channels/cortex",
    blurb: "Internal team chat via Cortex",
    order: 95,
  },

  capabilities: {
    chatTypes: ["direct" as const, "channel" as const],
    media: true,
    threads: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: false,
    effects: false,
    blockStreaming: false,
  },

  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

  config: {
    listAccountIds: (cfg: any) => listAccountIds(cfg),
    resolveAccount: (cfg: any, accountId?: string | null) => getAccountConfig(cfg, accountId),
    defaultAccountId: (_cfg: any) => DEFAULT_ACCOUNT_ID,
    isConfigured: (account: any) => Boolean(
      account.jwtSecret && account.realtimeUrl && account.apiUrl && account.botEmail && account.botName
    ),
  },

  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,
    sendText: async ({ to, text, cfg }: any) => {
      // Send via the shared socket.io connection (same path as browser clients)
      const channelId = extractChannelId(to);
      console.log(`[cortex-channel] outbound.sendText: to=${to} channelId=${channelId} text=${(text||'').substring(0,60)}...`);

      if (!channelId) {
        console.error(`[cortex-channel] Could not extract channelId from target: ${to}`);
        return { ok: false, error: `Invalid target: ${to}` };
      }

      const account = getAccountConfig(cfg);
      const result = await sendViaSocket(channelId, text, account);
      if (!result.ok) {
        console.error(`[cortex-channel] Send failed: ${result.error}`);
      } else {
        console.log(`[cortex-channel] Message sent successfully to channel ${channelId}`);
      }
      return { channel: CHANNEL_ID, ...result };
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      const { cfg, accountId, log, abortSignal } = ctx;
      const account = getAccountConfig(cfg, accountId);

      if (!account.enabled) {
        log?.info?.(`Cortex account ${accountId} is disabled, skipping`);
        return waitUntilAbort(abortSignal);
      }

      // All of these are required. There are no hardcoded defaults — missing
      // values must be supplied via channels.cortex in openclaw.json or via
      // the CORTEX_* environment variables (see README).
      const missing: string[] = [];
      if (!account.jwtSecret) missing.push("jwtSecret / CORTEX_JWT_SECRET");
      if (!account.apiUrl) missing.push("apiUrl / CORTEX_API_URL");
      if (!account.realtimeUrl) missing.push("realtimeUrl / CORTEX_REALTIME_URL");
      if (!account.botEmail) missing.push("botEmail / CORTEX_BOT_EMAIL");
      if (!account.botName) missing.push("botName / CORTEX_BOT_NAME");
      if (missing.length > 0) {
        log?.warn?.(`Cortex account ${accountId} missing required config: ${missing.join(", ")} — skipping`);
        return waitUntilAbort(abortSignal);
      }

      log?.info?.(`Starting Cortex Chat channel (account: ${accountId}, url: ${account.realtimeUrl})`);

      // Generate JWT for Bob
      const token = await generateJwt(account);

      // Connect to cortex-realtime via socket.io-client
      const { io } = await import("socket.io-client");
      const socket = io(account.realtimeUrl, {
        auth: { token },
        transports: ["websocket"],
        reconnection: true,
        reconnectionDelay: 3000,
        reconnectionAttempts: Infinity,
      });

      // Store socket reference for outbound.sendText
      activeSocket = socket;

      socket.on("connect", async () => {
        log?.info?.("✓ Connected to Cortex Realtime");
        ctx.setStatus?.({ running: true, lastStartAt: new Date().toISOString() });

        // Cache apiUrl + JWT so the channel_tasks_* tools registered
        // in src/tools.ts can reach cortex-api at agent-tool-call time.
        cachedApiUrl = account.apiUrl;
        cachedJwtToken = token;
      });

      socket.on("disconnect", (reason: string) => {
        log?.warn?.(`✗ Cortex Realtime disconnected: ${reason}`);
        ctx.setStatus?.({ running: false, lastStopAt: new Date().toISOString() });
        
        // Don't clear session mappings on disconnect - we want them to persist
        // This allows reconnections to maintain conversation continuity
        log?.info?.(`Session mappings preserved for reconnection (${channelSessions.size} channels)`);
      });

      socket.on("connect_error", (err: any) => {
        log?.error?.(`Cortex Realtime connection error: ${err.message}`);
      });

      // Listen for new messages
      socket.on("messages:new", async (message: any) => {
        // Skip system messages first (session compaction, etc.)
        if (message.content_type === "system") return;
        // Skip our own messages (bot responses)
        if (message.user_is_ai) return;
        if (message.user_email === account.botEmail) return;

        const channelId = message.channel_id;
        const messageId = message.id;
        const senderEmail = message.user_email || "unknown";
        const senderName = message.user_name || senderEmail;
        const content = message.content || "";

        // Get attachments directly from the message (they should be included in the broadcast)
        const attachments = message.attachments || [];
        log?.info?.(`Message ${messageId} has ${attachments.length} attachment(s):`, attachments);

        if (!content.trim() && attachments.length === 0) return;

        log?.info?.(`Cortex message from ${senderName} in channel ${channelId}: ${content.substring(0, 80)}...`);

        try {
          const rt = getCortexRuntime();
          const currentCfg = rt.config.loadConfig();

          // Fetch the active session (key + any summary seeded by a prior reset)
          let cortexSessionKey = `cortex-channel-${channelId}`;
          let cortexSessionSummary: string | null = null;
          try {
            const sessionRes = await fetch(`${account.apiUrl}/v1/chat/channels/${channelId}/session`, {
              headers: { Authorization: `Bearer ${(socket.auth as any)?.token || ""}` },
            });
            if (sessionRes.ok) {
              const sessionData = (await sessionRes.json()) as { session?: { sessionKey?: string; summary?: string } };
              if (sessionData?.session?.sessionKey) {
                cortexSessionKey = sessionData.session.sessionKey;
              }
              if (sessionData?.session?.summary) {
                cortexSessionSummary = sessionData.session.summary;
              }
            }
          } catch (e: any) {
            log?.warn?.(`Failed to fetch session for channel ${channelId}: ${e.message}`);
          }

          // Detect whether this message begins a fresh OpenClaw session. If so,
          // and cortex seeded a compaction summary on the session, inject it as
          // context so the bot picks up where the prior session left off.
          const previousOpenclawKey = channelSessions.get(channelId)?.openclawSessionKey;
          const sessionKey = getStableSessionKey(channelId, cortexSessionKey);
          const openclawSessionRotated = previousOpenclawKey !== sessionKey;

          // Fetch channel tasks for context injection
          const jwtForTasks = (socket.auth as any)?.token || cachedJwtToken || token;
          const channelTasksList = await fetchChannelTasks(account.apiUrl, channelId, jwtForTasks);
          const tasksContext = formatTasksForContext(channelTasksList);
          const untrustedContext: string[] = [];
          if (openclawSessionRotated && cortexSessionSummary) {
            untrustedContext.push(
              `Summary of previous conversation in this channel (prior session was compacted):\n\n${cortexSessionSummary}`
            );
            log?.info?.(`[cortex-channel] Injected compaction summary (${cortexSessionSummary.length} chars) into fresh OpenClaw session ${sessionKey}`);
          }
          if (tasksContext) untrustedContext.push(tasksContext);

          // Download attachments and add to message context
          let downloadedFiles: { localPath: string; attachment: any }[] = [];
          if (attachments.length > 0) {
            const jwtForDownload = (socket.auth as any)?.token || cachedJwtToken || token;
            downloadedFiles = await downloadAttachments(
              attachments,
              account.apiUrl,
              jwtForDownload,
              log
            );

            if (downloadedFiles.length > 0) {
              const attachmentLines = ["[media attached: " + downloadedFiles.map(f => 
                `${f.localPath} (${f.attachment.mime_type})`
              ).join(", ") + "]"];
              
              // Add human-readable attachment list
              attachmentLines.push("\nAttached files:");
              downloadedFiles.forEach((file) => {
                attachmentLines.push(`- ${file.attachment.filename} saved as ${file.localPath}`);
              });
              
              untrustedContext.push(attachmentLines.join('\n'));
            }
          }

          // Build MediaData with local paths
          const mediaData = downloadedFiles.map((file) => ({
            url: file.localPath,  // Use local path instead of API URL
            mimeType: file.attachment.mime_type,
            fileName: file.attachment.filename,
            fileSize: file.attachment.size_bytes,
            localPath: file.localPath,
          }));

          // Build inbound message context
          const msgCtx = rt.channel.reply.finalizeInboundContext({
            Body: content,
            RawBody: content,
            CommandBody: content,
            From: `cortex:${senderEmail}`,
            To: `cortex:channel:${channelId}`,
            SessionKey: sessionKey,
            AccountId: account.accountId,
            OriginatingChannel: CHANNEL_ID,
            OriginatingTo: `cortex:channel:${channelId}`,
            ChatType: "channel",
            SenderName: senderName,
            SenderId: senderEmail,
            Provider: CHANNEL_ID,
            Surface: CHANNEL_ID,
            ConversationLabel: `Cortex #${channelId}`,
            Timestamp: Date.now(),
            CommandAuthorized: true,
            UntrustedContext: untrustedContext,
            ...(mediaData.length > 0 && { MediaData: mediaData }),
          });

          log?.info?.(`Dispatching to agent for channel ${channelId}...`);

          // NOTE: no auto-task is created here anymore. Task management on
          // the Cortex channel is now bot-driven via the channel_tasks_*
          // tools in src/tools.ts — the bot decides when work is
          // complex enough to warrant a task list. See SOUL.md / BOOT.md
          // for the heuristic.

          try {
            // Typing + ai:status pipeline.
            //
            // Previously this used a hand-rolled StatusManager that passed
            // `onThinking`/`onToolCallStart`/`onToolCallEnd` options to the
            // dispatcher. OpenClaw's dispatcher silently ignores those hook
            // names — only `onReplyStart` / `onCleanup` / `typingCallbacks`
            // are honored — so nothing fired mid-turn and typing timed out
            // after 30s. The bundled Slack plugin gets around this by
            // wrapping its typing emit in `createTypingCallbacks`, which
            // handles keepalive internally: openclaw's agent runner calls
            // `typing.start` on run start, on reasoning deltas, on tool
            // starts, and on a keepalive timer; `createTypingCallbacks`
            // debounces + refreshes so the indicator stays lit for the
            // whole turn. Same pattern here.
            //
            // For the richer "status line" UI we also emit an ai:status
            // event (status="working", detail="thinking...") on the same
            // start/stop signals. That's the cortex-app equivalent of
            // Slack's `assistant.threads.setStatus` text line. OpenClaw
            // doesn't distinguish tool/reasoning/message starts at the
            // channel layer, so we can't show per-tool labels like
            // "searching" / "reading" — Slack has the same limitation.
            // Dynamic import with type cast: openclaw isn't a declared
            // peerDep on this package (we don't need its API for anything
            // else and TS resolving it requires shimming @types), so we
            // hit the subpath export at runtime only. The function shape
            // is well-known per openclaw's plugin-sdk/channels/typing.d.ts.
            const sdk = (await import(
              "openclaw/plugin-sdk/channel-reply-pipeline" as string
            )) as { createTypingCallbacks: (p: any) => any };
            const { createTypingCallbacks } = sdk;

            const botUser = { name: account.botName, email: account.botEmail };

            const typingCallbacks = createTypingCallbacks({
              start: async () => {
                socket.emit("typing:start", { channelId });
                socket.emit("ai:status", {
                  channelId,
                  status: "working",
                  detail: "thinking…",
                  user: botUser,
                });
              },
              stop: async () => {
                socket.emit("typing:stop", { channelId });
                socket.emit("ai:status", { channelId, status: null });
              },
              onStartError: (err: unknown) => {
                log?.debug?.(`typing start error (non-fatal): ${String(err)}`);
              },
              onStopError: (err: unknown) => {
                log?.debug?.(`typing stop error (non-fatal): ${String(err)}`);
              },
              // OpenClaw's internal typing loop will call start() at this
              // cadence while the run is active. 10s is tight enough that
              // the 30s auto-clear in cortex-app's chat store never kicks
              // in mid-turn, but not so aggressive that it floods the
              // socket on long tool chains.
              keepaliveIntervalMs: 10_000,
              // Safety TTL: force-stop typing after 10 min no matter what,
              // so a crashed agent run can't leave a permanent indicator.
              maxDurationMs: 10 * 60_000,
            });

            // Dispatch to agent — reply comes back via outbound.sendText
            await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: { text?: string; body?: string }) => {
                  const text = payload?.text ?? payload?.body;
                  if (!text?.trim()) return;
                  log?.info?.(`Delivering reply to channel ${channelId} (${text.substring(0, 60)}...)`);
                  // Pass the resolved `account` through so sendViaSocket has
                  // apiUrl. Before v2.0.0 this was covered by a hardcoded
                  // fallback URL inside sendViaSocket; removing that turned
                  // every agent reply into a delivery failure until we fixed
                  // the account-passing in v2.0.1.
                  const result = await sendViaSocket(channelId, text, account);
                  if (!result.ok) {
                    log?.error?.(`Failed to deliver reply: ${result.error}`);
                  }
                },
                // Typing keepalive pipeline. OpenClaw's agent runner calls
                // typingCallbacks.onReplyStart and keeps typing alive until
                // the run settles / onCleanup fires.
                typingCallbacks,
                onReplyStart: typingCallbacks.onReplyStart,
                onCleanup: typingCallbacks.onCleanup,
                onError: () => {
                  typingCallbacks.onCleanup?.();
                },
              },
            });
          } catch (dispatchErr: any) {
            // Let the error propagate — typing pipeline cleans itself up
            // via onError/onCleanup; nothing else to do here. The bot's
            // own channel_tasks tools are responsible for reflecting run
            // failure in the task list (if it had created any).
            throw dispatchErr;
          }

          log?.info?.(`Dispatch completed for channel ${channelId}`);

          // Report real token usage from OpenClaw session back to Cortex.
          // We read ~/.openclaw/agents/main/sessions/sessions.json directly
          // because (a) the in-memory session store passed via `rt` is not
          // reliably populated in the plugin dispatch context, and (b) the
          // gateway systemd unit doesn't have `openclaw` on PATH, so shelling
          // out to the CLI was failing silently. The JSON file is the
          // source-of-truth the gateway itself writes after every turn.
          try {
            const fs = await import("fs/promises");
            const path = await import("path");
            const os = await import("os");
            const home = os.homedir();
            const sessionsPath = path.join(home, ".openclaw", "agents", "main", "sessions", "sessions.json");
            const configPath = path.join(home, ".openclaw", "openclaw.json");
            let totalTokens = 0;
            let servedModel: string | null = null;
            let expectedModel: string | null = null;
            try {
              const raw = await fs.readFile(sessionsPath, "utf8");
              const all = JSON.parse(raw) as Record<string, any>;
              const suffix = `:${sessionKey}`;
              let best: any = null;
              for (const [k, v] of Object.entries(all)) {
                if (k === sessionKey || k.endsWith(suffix)) {
                  if (!best || (v?.updatedAt ?? 0) > (best?.updatedAt ?? 0)) best = v;
                }
              }
              if (best?.totalTokens) totalTokens = best.totalTokens;
              if (best?.model) {
                // Session stores bare model id (e.g. "nemotron-3-super:cloud").
                // Provider is separate.
                servedModel = best.modelProvider ? `${best.modelProvider}/${best.model}` : best.model;
              }
            } catch { /* non-critical */ }

            // Read the configured primary so we can detect failovers.
            try {
              const cfgRaw = await fs.readFile(configPath, "utf8");
              const cfg = JSON.parse(cfgRaw) as any;
              expectedModel = cfg?.agents?.defaults?.model?.primary || null;
            } catch { /* non-critical */ }

            if (totalTokens > 0) {
              const jwtToken = await generateJwt(account);
              await fetch(`${account.apiUrl}/v1/chat/channels/${channelId}/session`, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  "Authorization": `Bearer ${jwtToken}`,
                },
                body: JSON.stringify({ tokenCount: totalTokens }),
              });
              log?.info?.(`Updated token count for channel ${channelId}: ${totalTokens}`);
            }

            // Detect fallback: session served by a model other than the
            // configured primary. Emit ai:status in-channel (via the
            // active socket, same path as typing events) and, if a
            // CORTEX_ALERTS_CHANNEL_ID is configured, post a one-line
            // message to that channel via the apiRequest relay so the
            // broadcast/unread-bump pipeline fires correctly.
            if (servedModel && expectedModel && servedModel !== expectedModel) {
              const msg = `${expectedModel.split("/").pop()} rate-limited → served by ${servedModel.split("/").pop()}`;
              try {
                if (activeSocket?.connected) {
                  activeSocket.emit("ai:status", {
                    channelId,
                    status: "fallback",
                    message: `⚠️ ${msg}`,
                  });
                }
              } catch { /* best-effort */ }

              const alertsId = parseInt(process.env.CORTEX_ALERTS_CHANNEL_ID || "0", 10);
              if (alertsId > 0 && activeSocket?.connected) {
                activeSocket.emit("apiRequest.request", {
                  url: "/v1/chat/messages",
                  params: {
                    method: "POST",
                    body: {
                      channelId: alertsId,
                      content: `⚠️ **Model fallback** in channel #${channelId}: ${msg}`,
                      contentType: "text",
                      metadata: { source: "cortex-channel", servedModel, expectedModel, originChannel: channelId },
                    },
                  },
                }, () => { /* fire-and-forget */ });
              }
              log?.info?.(`Fallback detected: expected=${expectedModel} served=${servedModel}`);
            }
          } catch (tokenErr: any) {
            log?.warn?.(`Failed to update token count / detect fallback: ${tokenErr.message}`);
          }
        } catch (err: any) {
          log?.error?.(`Error processing Cortex message: ${err.message}`);
          log?.error?.(`Stack: ${err.stack}`);
        }
      });

      // Clean up on abort
      return waitUntilAbort(abortSignal, async () => {
        log?.info?.("Stopping Cortex Chat channel");
        activeSocket = null;
        cachedApiUrl = null;
        cachedJwtToken = null;
        socket.disconnect();
      });
    },
  },
};

// ─── JWT generation ──────────────────────────────────

async function generateJwt(account: any): Promise<string> {
  try {
    const jwt = await import("jsonwebtoken");
    const sign = (jwt as any).default?.sign || (jwt as any).sign;
    return sign(
      { email: account.botEmail, name: account.botName, picture: "" },
      account.jwtSecret,
      { expiresIn: "24h" }
    );
  } catch {
    throw new Error("jsonwebtoken not available — install it in the extensions directory");
  }
}
