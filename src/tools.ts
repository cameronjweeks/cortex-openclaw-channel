// OpenClaw tool registrations for Cortex channel tasks.
//
// These are how the bot (running inside openclaw) manages the
// user-visible task list on a Cortex channel. Before this plugin
// version the task list was auto-populated (one task per inbound
// user message, completed when the reply went out) — which was
// redundant with the typing/status indicator and flooded the panel
// with meaningless rows. Now the bot maintains the list itself:
//
//  channel_tasks_list   : read current tasks (view what's queued)
//  channel_tasks_create : add a task (what the bot is about to do)
//  channel_tasks_update : change status/label (in_progress, completed,
//                         cancelled) as work progresses
//
// Tools are context-aware: the agent run's `sessionKey` encodes the
// cortex channel id (our own getStableSessionKey produces
// "openclaw-cortex-channel-<channelId>-s<N>" keys), so we parse it
// out at execute time rather than making the agent re-supply it.

export type TaskToolsContext = {
  /** Returns the base URL of cortex-api for the currently-active account. */
  getApiUrl(): string | null;
  /** Returns the bearer JWT the plugin uses for cortex-api calls. */
  getToken(): string | null;
};

/** Parse the cortex channel id out of the agent run's session key. */
function channelIdFromSessionKey(sessionKey: string | undefined): number | null {
  if (!sessionKey) return null;
  // Plugin session keys look like "openclaw-cortex-channel-<n>-s<m>"
  // or legacy "cortex-channel-<n>-s<m>" / "cortex-channel-<n>".
  const m = sessionKey.match(/cortex-channel-(\d+)/);
  return m ? Number(m[1]) : null;
}

async function fetchJson(url: string, init: any = {}, token: string): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
  if (!res.ok) {
    const msg = body?.error || body?.message || `HTTP ${res.status}`;
    throw new Error(`cortex-api ${init.method || "GET"} ${url}: ${msg}`);
  }
  return body;
}

function requireChannel(ctx: { sessionKey?: string }): number {
  const id = channelIdFromSessionKey(ctx.sessionKey);
  if (!id) {
    throw new Error(
      "channel task tools require an active Cortex channel session; " +
      "no cortex channel id found in sessionKey (did you call this outside a Cortex channel turn?)",
    );
  }
  return id;
}

function requireAuth(taskCtx: TaskToolsContext): { apiUrl: string; token: string } {
  const apiUrl = taskCtx.getApiUrl();
  const token = taskCtx.getToken();
  if (!apiUrl || !token) {
    throw new Error("cortex-channel is not connected yet — task tools cannot reach cortex-api");
  }
  return { apiUrl, token };
}

// zod isn't a plugin dependency, so parameters are hand-rolled schemas.
// OpenClaw accepts JSON Schema here.
const listParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    includeCompleted: {
      type: "boolean",
      description: "Include completed and cancelled tasks in the result (default: false).",
    },
  },
} as const;

const createParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["label"],
  properties: {
    label: { type: "string", description: "Short description of what this task is. Be specific." },
    status: {
      type: "string",
      enum: ["not_started", "in_progress"],
      description: 'Initial status; "in_progress" if you\'re starting it now, else "not_started". Default: "not_started".',
    },
  },
} as const;

const updateParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["taskId"],
  properties: {
    taskId: { type: "integer", description: "id of the task to update (returned from channel_tasks_create or _list)" },
    status: {
      type: "string",
      enum: ["not_started", "in_progress", "completed", "cancelled"],
      description: "New status. Set 'cancelled' to abort without deleting the row.",
    },
    label: { type: "string", description: "Optional new label if you need to rephrase the task." },
  },
} as const;

export function createChannelTaskTools(taskCtx: TaskToolsContext) {
  return [
    {
      def: {
        name: "channel_tasks_list",
        label: "List channel tasks",
        description:
          "List the current task list in the Cortex channel you're replying in. Use this when you want to see what tasks already exist before adding new ones (e.g. a user may have pre-queued work for you in the 'not_started' state).",
        parameters: listParamsSchema,
        execute: async (_toolCallId: string, rawParams: any, ctx: { sessionKey?: string }) => {
          const channelId = requireChannel(ctx);
          const { apiUrl, token } = requireAuth(taskCtx);
          const includeCompleted = Boolean(rawParams?.includeCompleted);
          const body = await fetchJson(
            `${apiUrl}/v1/chat/channels/${channelId}/tasks${includeCompleted ? "?includeCompleted=1" : ""}`,
            {},
            token,
          );
          const tasks = body?.tasks || [];
          const lines = tasks.length
            ? tasks.map((t: any) => {
                const icon = t.status === "in_progress" ? "◉" : t.status === "completed" ? "✓" : t.status === "cancelled" ? "✕" : "○";
                return `${icon} #${t.id} [${t.status}] ${t.label}`;
              })
            : ["(no tasks in this channel)"];
          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { channelId, tasks },
          };
        },
      },
      opts: { name: "channel_tasks_list" },
    },
    {
      def: {
        name: "channel_tasks_create",
        label: "Create channel task",
        description:
          "Add a task to the Cortex channel's task list so the user can see what you're working on. " +
          "Use this for MULTI-STEP WORK only — when a single user request will take multiple distinct steps (e.g. 'audit the config, fix issues, open a PR' → three tasks). " +
          "Do NOT create a task for every chat message. Do NOT create one for simple Q&A. " +
          "After the tasks are visible, update them as you complete each step with channel_tasks_update.",
        parameters: createParamsSchema,
        execute: async (_toolCallId: string, rawParams: any, ctx: { sessionKey?: string }) => {
          const channelId = requireChannel(ctx);
          const { apiUrl, token } = requireAuth(taskCtx);
          const label = String(rawParams?.label || "").trim();
          if (!label) throw new Error("label is required");
          const status = rawParams?.status === "in_progress" ? "in_progress" : "not_started";
          const body = await fetchJson(
            `${apiUrl}/v1/chat/channels/${channelId}/tasks`,
            { method: "POST", body: JSON.stringify({ label, status, metadata: { createdByBot: true } }) },
            token,
          );
          const task = body?.task;
          return {
            content: [{ type: "text", text: `Created task #${task?.id}: ${task?.label} [${task?.status}]` }],
            details: { channelId, task },
          };
        },
      },
      opts: { name: "channel_tasks_create" },
    },
    {
      def: {
        name: "channel_tasks_update",
        label: "Update channel task",
        description:
          "Update the status (or label) of an existing channel task. " +
          "Call this whenever you transition a task: set 'in_progress' when you start, 'completed' when done, or 'cancelled' if the step is no longer needed.",
        parameters: updateParamsSchema,
        execute: async (_toolCallId: string, rawParams: any, ctx: { sessionKey?: string }) => {
          const channelId = requireChannel(ctx);
          const { apiUrl, token } = requireAuth(taskCtx);
          const taskId = Number(rawParams?.taskId);
          if (!Number.isFinite(taskId)) throw new Error("taskId must be a number");
          const patch: Record<string, any> = {};
          if (rawParams?.status) patch.status = rawParams.status;
          if (rawParams?.label) patch.label = String(rawParams.label).trim();
          if (!Object.keys(patch).length) throw new Error("nothing to update (pass status and/or label)");
          const body = await fetchJson(
            `${apiUrl}/v1/chat/channels/${channelId}/tasks/${taskId}`,
            { method: "PUT", body: JSON.stringify(patch) },
            token,
          );
          const task = body?.task;
          return {
            content: [{ type: "text", text: `Task #${task?.id} → [${task?.status}] ${task?.label}` }],
            details: { channelId, task },
          };
        },
      },
      opts: { name: "channel_tasks_update" },
    },
  ];
}
