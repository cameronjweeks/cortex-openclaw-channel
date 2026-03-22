"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = createChannel;
const ws_1 = __importDefault(require("ws"));
// ─── Session Management ──────────────────────────────
// Import the bidirectional session manager
const session_manager_v3_1 = require("./session-manager-v3");
// Will be initialized with API URL and token when account starts
let sessionManager = null;
async function start() {
    if (!this.account?.apiUrl || !this.account?.jwtToken) {
        throw new Error('Cortex channel requires apiUrl and jwtToken in account config');
    }
    // Initialize session manager with configurable thresholds
    sessionManager = new session_manager_v3_1.BidirectionalSessionManager(this.account.apiUrl, this.account.jwtToken, {
        tokenWarningThreshold: this.account.tokenWarningThreshold,
        tokenResetThreshold: this.account.tokenResetThreshold,
        messageResetThreshold: this.account.messageResetThreshold
    });
    this.channels = new Map();
    this.messageQueue = [];
    await connectWebSocket.call(this);
    await loadChannels.call(this);
    this.emit('_started');
}
async function connectWebSocket() {
    const wsUrl = this.account.apiUrl.replace('http', 'ws') + '/v1/chat/stream';
    this.ws = new ws_1.default(wsUrl, {
        headers: {
            'Authorization': `Bearer ${this.account.jwtToken}`
        }
    });
    this.ws.on('open', () => {
        console.log('[cortex-channel] WebSocket connected');
        this.reconnectAttempts = 0;
        this.heartbeatInterval = setInterval(() => {
            if (this.ws?.readyState === ws_1.default.OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
            }
        }, 30000);
    });
    this.ws.on('message', async (data) => {
        try {
            const event = JSON.parse(data.toString());
            if (event.type === 'message' && event.data) {
                const msg = event.data;
                if (shouldProcessMessage.call(this, msg.channel_id)) {
                    const channelInfo = this.channels.get(String(msg.channel_id));
                    if (channelInfo && msg.user_id !== Number(this.account.userId)) {
                        // Get session info with token count
                        const sessionInfo = await sessionManager.getSessionKey(msg.channel_id, msg.session_key || `cortex-channel-${msg.channel_id}`, msg.context_tokens // Cortex should pass this
                        );
                        const message = {
                            text: msg.content,
                            sender: {
                                id: String(msg.user_id),
                                name: msg.user_name || msg.user_email || 'Unknown'
                            },
                            metadata: {
                                channelId: msg.channel_id,
                                channelName: channelInfo.name,
                                messageId: msg.id,
                                cortexSessionKey: msg.session_key,
                                sessionStats: sessionManager.getStats(msg.channel_id),
                                // Add attachments to metadata so they're accessible to OpenClaw
                                attachments: msg.attachments || []
                            },
                            // Use the stable/managed session key
                            SessionKey: sessionInfo.sessionKey
                        };
                        // If OpenClaw initiated a reset, notify in the channel
                        if (sessionInfo.shouldNotifyReset) {
                            await this.send({ channelId: msg.channel_id }, `🔄 Session automatically reset: ${sessionInfo.resetReason}`);
                        }
                        this.emit('_message', message);
                    }
                }
            }
            else if (event.type === 'session:reset') {
                // Handle Cortex-initiated resets (Task 2: UI notifications)
                const { channelId, reason, newSessionKey } = event.data;
                console.log(`[cortex-channel] Cortex reset session for channel ${channelId}: ${reason}`);
                // Notify in the channel
                await this.send({ channelId }, `🔄 Session reset by Cortex: ${reason}`);
            }
        }
        catch (err) {
            console.error('[cortex-channel] Error processing WebSocket message:', err);
        }
    });
    this.ws.on('error', (error) => {
        console.error('[cortex-channel] WebSocket error:', error);
    });
    this.ws.on('close', () => {
        console.log('[cortex-channel] WebSocket disconnected');
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts || 0), 30000);
        this.reconnectAttempts = (this.reconnectAttempts || 0) + 1;
        setTimeout(() => connectWebSocket.call(this), delay);
    });
}
async function loadChannels() {
    try {
        const response = await fetch(`${this.account.apiUrl}/v1/chat/channels`, {
            headers: {
                'Authorization': `Bearer ${this.account.jwtToken}`
            }
        });
        if (!response.ok) {
            throw new Error(`Failed to load channels: ${response.status}`);
        }
        const channels = await response.json();
        for (const channel of channels) {
            if (shouldProcessMessage.call(this, channel.id)) {
                this.channels.set(String(channel.id), {
                    id: channel.id,
                    name: channel.name,
                    users: channel.users || []
                });
                console.log(`[cortex-channel] Monitoring channel: ${channel.name} (ID: ${channel.id})`);
            }
        }
        console.log(`[cortex-channel] Loaded ${this.channels.size} channels`);
    }
    catch (err) {
        console.error('[cortex-channel] Failed to load channels:', err.message);
    }
}
function shouldProcessMessage(channelId) {
    if (this.account.allowAllChannels)
        return true;
    if (!this.account.channels?.length)
        return false;
    return this.account.channels.includes(channelId);
}
async function send(target, message) {
    const channelId = target.channelId || target.metadata?.channelId;
    if (!channelId) {
        throw new Error('Channel ID is required for sending messages');
    }
    try {
        const response = await fetch(`${this.account.apiUrl}/v1/chat/channels/${channelId}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.account.jwtToken}`
            },
            body: JSON.stringify({
                content: message,
                user_id: Number(this.account.userId)
            })
        });
        if (!response.ok) {
            throw new Error(`Failed to send message: ${response.status}`);
        }
        const result = await response.json();
        return {
            messageId: String(result.id),
            timestamp: new Date(result.created_at),
            metadata: { channelId }
        };
    }
    catch (err) {
        console.error('[cortex-channel] Send error:', err.message);
        throw err;
    }
}
async function sendStreaming(target, message, callback) {
    // For now, just send non-streaming
    const result = await this.send(target, message);
    callback({ text: message, done: true });
    return result;
}
// Task 4: Manual force sync command
async function forceSync(channelId) {
    if (!sessionManager) {
        return 'Session manager not initialized';
    }
    try {
        if (channelId) {
            // Force sync specific channel
            const result = await sessionManager.forceReset(channelId, 'Manual force sync');
            return `✅ Force synced channel ${channelId}: ${result.newSessionKey}`;
        }
        else {
            // Sync all active channels
            let synced = 0;
            for (const [_, channel] of this.channels) {
                await sessionManager.forceReset(channel.id, 'Manual force sync all');
                synced++;
            }
            return `✅ Force synced ${synced} channels`;
        }
    }
    catch (err) {
        return `❌ Force sync failed: ${err.message}`;
    }
}
async function stop() {
    if (this.ws) {
        this.ws.close();
    }
    if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
    }
    this.emit('_stopped');
}
function createChannel() {
    return {
        start,
        stop,
        send,
        sendStreaming,
        // Expose force sync as a channel method
        forceSync
    };
}
//# sourceMappingURL=channel.js.map