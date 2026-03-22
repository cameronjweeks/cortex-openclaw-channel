import { SessionManager } from "./session-manager-v3.js";
import { getRuntime } from "./runtime.js";

const CHANNEL_ID = "cortex";
const DEFAULT_ACCOUNT_ID = "default";

// Enhanced plugin with rich status indicators
export const enhancedCortexPlugin = {
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

  // Copy all existing config/outbound/gateway from original
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  
  config: {
    // ... (copy from original)
  },

  outbound: {
    // ... (copy from original)
  },

  gateway: {
    startAccount: async (ctx: any) => {
      // ... (most of the original code)
      
      // Enhanced dispatch with rich status callbacks
      const enhancedDispatch = async (message: any, socket: any, channelId: number) => {
        const { dispatch } = ctx;
        const sessionKey = sessionManager.getStableSessionKey(channelId);
        
        // Track typing state
        let typingTimer: any = null;
        let lastStatus: string | null = null;
        
        const stopTyping = () => {
          if (typingTimer) {
            clearTimeout(typingTimer);
            typingTimer = null;
          }
          socket.emit("typing:stop", { channelId });
          if (lastStatus && lastStatus !== "typing") {
            socket.emit("ai:status", { channelId, status: null });
          }
          lastStatus = null;
        };
        
        const updateStatus = (status: string, detail?: string) => {
          // Map OpenClaw statuses to user-friendly ones
          const statusMap: Record<string, string> = {
            "tool_use": "working",
            "thinking": "thinking",
            "browsing": "browsing",
            "coding": "coding",
            "searching": "searching",
            "analyzing": "analyzing",
            "reading": "reading",
            "writing": "writing",
          };
          
          const mappedStatus = statusMap[status] || status;
          
          // Clear typing timer on status change
          if (typingTimer) {
            clearTimeout(typingTimer);
            typingTimer = null;
          }
          
          // Send status update
          socket.emit("ai:status", { 
            channelId, 
            status: mappedStatus,
            detail: detail || null,
            user: { name: "Bob", email: "bob@backv.co" }
          });
          
          lastStatus = mappedStatus;
          
          // Auto-clear after 30 seconds
          typingTimer = setTimeout(stopTyping, 30000);
        };
        
        await dispatch({
          sessionKey,
          message,
          callbacks: {
            onReplyChunk: async ({ text }: any) => {
              if (!text?.trim()) return;
              const result = await sendViaSocket(channelId, text);
              if (!result.ok) {
                log?.error?.(`Failed to deliver reply: ${result.error}`);
              }
              stopTyping(); // Stop typing when message sent
            },
            onReplyStart: () => {
              socket.emit("typing:start", { channelId });
              typingTimer = setTimeout(stopTyping, 30000);
              lastStatus = "typing";
            },
            onReplyEnd: () => {
              stopTyping();
            },
            onThinking: ({ thinkingLevel }: any) => {
              updateStatus("thinking", thinkingLevel);
            },
            onToolCallStart: ({ toolName }: any) => {
              // Map tool names to friendly statuses
              const toolStatusMap: Record<string, string> = {
                "web_search": "searching",
                "web_fetch": "browsing",
                "browser": "browsing",
                "exec": "working",
                "read": "reading",
                "write": "writing",
                "edit": "writing",
                "code": "coding",
                "analyze": "analyzing",
                "image": "analyzing",
                "pdf": "reading",
              };
              
              const status = toolStatusMap[toolName] || "working";
              updateStatus(status, toolName);
            },
            onToolCallEnd: () => {
              updateStatus("thinking");
            },
            onError: () => {
              stopTyping();
            },
          },
        });
      };
      
      // ... rest of gateway code
    }
  }
};