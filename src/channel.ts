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
import { TaskPersistenceManager } from "./task-persistence.js";

const CHANNEL_ID = "cortex";
const DEFAULT_ACCOUNT_ID = "default";

// ─── Shared socket reference ─────────────────────────
// The gateway.startAccount creates the socket connection.
// outbound.sendText uses it to send replies via RPC.
let activeSocket: any = null;
let cachedBotId: number | null = null;
let cachedJwtToken: string | null = null;
let taskPersistenceManager: TaskPersistenceManager | null = null;

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

// ─── Task reporting helper ───────────────────────────

async function reportTask(
  apiUrl: string,
  botId: number,
  token: string,
  data: { taskKey: string; label: string; status: string; type?: string; metadata?: any }
): Promise<void> {
  try {
    const res = await fetch(`${apiUrl}/v1/bots/${botId}/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[cortex-channel] Task report failed (${res.status}): ${body}`);
    }
  } catch (err: any) {
    console.error(`[cortex-channel] Task report error: ${err.message}`);
  }
}

async function fetchBotId(apiUrl: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(`${apiUrl}/v1/bots`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Find the bot whose user matches this connection (first one owned or self)
    if (data.bots?.length) return data.bots[0].id;
    return null;
  } catch {
    return null;
  }
}

// ─── Channel Task helpers ────────────────────────────

async function fetchChannelTasks(apiUrl: string, channelId: number, token: string): Promise<any[]> {
  try {
    const res = await fetch(`${apiUrl}/v1/chat/channels/${channelId}/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
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
  return `Channel Tasks:\n${lines.join('\n')}`;
}

async function createChannelTask(
  apiUrl: string, channelId: number, token: string,
  data: { label: string; status?: string; sourceMessageId?: number; metadata?: any }
): Promise<any | null> {
  try {
    const res = await fetch(`${apiUrl}/v1/chat/channels/${channelId}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
    if (!res.ok) return null;
    return (await res.json()).task;
  } catch {
    return null;
  }
}

async function updateChannelTaskStatus(
  apiUrl: string, channelId: number, taskId: number, token: string,
  updates: { status?: string; label?: string; metadata?: any }
): Promise<any | null> {
  try {
    const res = await fetch(`${apiUrl}/v1/chat/channels/${channelId}/tasks/${taskId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(updates),
    });
    if (!res.ok) return null;
    return (await res.json()).task;
  } catch {
    return null;
  }
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

        // Cache bot ID and JWT for task reporting
        if (!cachedBotId) {
          cachedJwtToken = token;
          cachedBotId = await fetchBotId(account.apiUrl, token);
          if (cachedBotId) {
            log?.info?.(`Bot ID resolved: ${cachedBotId}`);
            
            // Initialize task persistence manager
            if (!taskPersistenceManager) {
              taskPersistenceManager = new TaskPersistenceManager(account.apiUrl, token, log, socket);
              await taskPersistenceManager.init();
              
              // Clean up any orphaned tasks from previous run
              await taskPersistenceManager.cleanupOrphanedTasks(cachedBotId);
              log?.info?.("Task persistence manager initialized");
            }
          } else {
            log?.warn?.("Could not resolve bot ID — task reporting disabled");
          }
        }
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
              const sessionData = await sessionRes.json();
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

          // Report bot_task as running (existing system-level tracking)
          const taskKey = `msg-${channelId}-${Date.now()}`;
          const taskLabel = content.length > 80 ? content.substring(0, 77) + "..." : content;
          if (cachedBotId && cachedJwtToken) {
            reportTask(account.apiUrl, cachedBotId, cachedJwtToken, {
              taskKey,
              label: taskLabel,
              status: "running",
              type: "session",
              metadata: { sessionKey, channelId, sender: senderName },
            });
            
            // Add task to persistence manager
            if (taskPersistenceManager) {
              await taskPersistenceManager.addTask({
                taskKey,
                botId: cachedBotId,
                channelId,
                sessionKey,
                label: taskLabel,
                status: "running",
                metadata: { sender: senderName },
              });
            }
          }

          // Create a channel task for this work item (visible in the UI panel)
          let channelTaskId: number | null = null;
          const channelTaskToken = jwtForTasks;
          try {
            const ct = await createChannelTask(account.apiUrl, channelId, channelTaskToken, {
              label: taskLabel,
              status: "in_progress",
              sourceMessageId: message.id || null,
              metadata: { sender: senderName, sessionKey, automated: true },
            });
            if (ct) {
              channelTaskId = ct.id;
              log?.info?.(`Channel task #${ct.id} created for channel ${channelId}`);
              
              // Update persistence with channel task ID
              if (taskPersistenceManager && taskKey) {
                await taskPersistenceManager.updateTask(taskKey, { channelTaskId: ct.id });
              }
            }
          } catch (ctErr: any) {
            log?.warn?.(`Failed to create channel task: ${ctErr.message}`);
          }

          let taskStatus = "completed";
          let taskError: string | undefined;

          try {
            // StatusManager for rich AI indicators (inline to avoid TS import issues)
            class StatusManager {
              private socket: any;
              private channelId: number;
              private botUser: { name: string; email: string };
              private currentTimer: any = null;
              private lastStatus: string | null = null;

              constructor(socket: any, channelId: number, botUser: { name: string; email: string }) {
                this.socket = socket;
                this.channelId = channelId;
                this.botUser = botUser;
              }

              clearTimer() {
                if (this.currentTimer) {
                  clearTimeout(this.currentTimer);
                  this.currentTimer = null;
                }
              }

              startTyping() {
                this.clearTimer();
                this.socket.emit("typing:start", { channelId: this.channelId });
                this.lastStatus = "typing";
                this.currentTimer = setTimeout(() => this.stopAll(), 30000);
              }

              updateStatus(status: string, detail?: string) {
                this.clearTimer();

                const statusMap: Record<string, string> = {
                  "web_search": "searching",
                  "web_fetch": "browsing",
                  "browser": "browsing",
                  "read": "reading",
                  "write": "writing",
                  "edit": "writing",
                  "thinking": "thinking"
                };

                const mappedStatus = statusMap[status] || "working";
                this.lastStatus = mappedStatus;

                this.socket.emit("ai:status", {
                  channelId: this.channelId,
                  status: mappedStatus,
                  detail: detail || null,
                  user: this.botUser,
                });

                this.currentTimer = setTimeout(() => this.stopAll(), 30000);
              }

              stopAll() {
                this.clearTimer();
                if (this.lastStatus && this.lastStatus !== "typing") {
                  this.socket.emit("ai:status", {
                    channelId: this.channelId,
                    status: null
                  });
                }
                this.socket.emit("typing:stop", { channelId: this.channelId });
                this.lastStatus = null;
              }
            }

            const statusManager = new StatusManager(socket, channelId, {
              name: account.botName,
              email: account.botEmail,
            });
            
            // Set up heartbeat timer for task health monitoring
            let heartbeatTimer: NodeJS.Timer | null = null;
            if (taskPersistenceManager && taskKey) {
              heartbeatTimer = setInterval(async () => {
                await taskPersistenceManager.heartbeat(taskKey);
              }, 20000); // Send heartbeat every 20 seconds
            }
            
            // Dispatch to agent — reply comes back via outbound.sendText
            await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: { text?: string; body?: string }) => {
                  const text = payload?.text ?? payload?.body;
                  if (!text?.trim()) return;
                  log?.info?.(`Delivering reply to channel ${channelId} (${text.substring(0, 60)}...)`);
                  const result = await sendViaSocket(channelId, text);
                  if (!result.ok) {
                    log?.error?.(`Failed to deliver reply: ${result.error}`);
                  }
                },
                onReplyStart: () => {
                  statusManager.startTyping();
                },
                onReplyEnd: () => {
                  statusManager.stopAll();
                },
                onThinking: ({ thinkingLevel }: any) => {
                  statusManager.updateStatus("thinking", thinkingLevel);
                },
                onToolCallStart: ({ toolName }: any) => {
                  log?.debug?.(`Tool call start: ${toolName}`);
                  statusManager.updateStatus(toolName);
                },
                onToolCallEnd: () => {
                  statusManager.updateStatus("thinking");
                },
                onError: () => {
                  statusManager.stopAll();
                },
              },
            });
          } catch (dispatchErr: any) {
            taskStatus = "failed";
            taskError = dispatchErr.message;
            throw dispatchErr;
          } finally {
            // Stop heartbeat timer
            if (heartbeatTimer) {
              clearInterval(heartbeatTimer);
            }
            
            // Complete task via persistence manager (which handles both bot and channel tasks)
            if (taskPersistenceManager && taskKey) {
              await taskPersistenceManager.completeTask(taskKey, taskStatus as 'completed' | 'failed', taskError);
            } else if (cachedBotId && cachedJwtToken) {
              // Fallback if no persistence manager
              reportTask(account.apiUrl, cachedBotId, cachedJwtToken, {
                taskKey,
                label: taskLabel,
                status: taskStatus,
                type: "session",
                metadata: {
                  sessionKey,
                  channelId,
                  sender: senderName,
                  ...(taskError ? { error: taskError } : {}),
                },
              });
            }

            // Complete the channel task (auto-hide after 24h kicks in server-side)
            if (channelTaskId) {
              try {
                const finalStatus = taskStatus === "failed" ? "cancelled" : "completed";
                await updateChannelTaskStatus(account.apiUrl, channelId, channelTaskId, channelTaskToken, {
                  status: finalStatus,
                  ...(taskError ? { metadata: { error: taskError } } : {}),
                });
                log?.info?.(`Channel task #${channelTaskId} → ${finalStatus}`);
              } catch (ctErr: any) {
                log?.warn?.(`Failed to update channel task #${channelTaskId}: ${ctErr.message}`);
              }
            }
          }

          log?.info?.(`Dispatch completed for channel ${channelId}`);

          // Report real token usage from OpenClaw session back to Cortex
          try {
            const sessions = rt.config?.sessionStore?.sessions || rt.sessions;
            // Try to read session token info from the store
            let totalTokens = 0;
            if (sessions) {
              // The session store might be accessible via runtime
              const sessionEntry = typeof sessions.get === 'function' 
                ? sessions.get(sessionKey) 
                : sessions[sessionKey];
              if (sessionEntry?.totalTokens) {
                totalTokens = sessionEntry.totalTokens;
              }
            }
            
            // If we can't read the session store directly, try the CLI approach
            if (!totalTokens) {
              const { execSync } = await import("child_process");
              try {
                const output = execSync(
                  `openclaw sessions --json 2>/dev/null | grep -A15 '"key": "${sessionKey}"'`,
                  { encoding: "utf8", timeout: 5000 }
                );
                const tokenMatch = output.match(/"totalTokens":\s*(\d+)/);
                if (tokenMatch) totalTokens = parseInt(tokenMatch[1]);
              } catch { /* non-critical */ }
            }

            if (totalTokens > 0) {
              // Update Cortex session with real token count
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
          } catch (tokenErr: any) {
            log?.warn?.(`Failed to update token count: ${tokenErr.message}`);
          }
        } catch (err: any) {
          log?.error?.(`Error processing Cortex message: ${err.message}`);
          log?.error?.(`Stack: ${err.stack}`);
        }
      });

      // Clean up on abort
      return waitUntilAbort(abortSignal, async () => {
        log?.info?.("Stopping Cortex Chat channel");
        
        // Persist all active tasks before shutting down
        if (taskPersistenceManager) {
          await taskPersistenceManager.shutdown();
          taskPersistenceManager = null;
        }
        
        activeSocket = null;
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
