"use strict";
// ─── Session Management V3 - Full Bidirectional ──────────
// Handles both Cortex-initiated and OpenClaw-initiated resets
Object.defineProperty(exports, "__esModule", { value: true });
exports.BidirectionalSessionManager = void 0;
class BidirectionalSessionManager {
    constructor(apiUrl, jwtToken, config = {}) {
        this.apiUrl = apiUrl;
        this.jwtToken = jwtToken;
        this.sessions = new Map();
        // Task 3: Configurable thresholds
        this.TOKEN_WARNING_THRESHOLD = config.tokenWarningThreshold || 150000;
        this.TOKEN_RESET_THRESHOLD = config.tokenResetThreshold || 180000;
        this.MESSAGE_RESET_THRESHOLD = config.messageResetThreshold || 500;
        this.SESSION_TIMEOUT_MS = config.sessionTimeoutMs || (24 * 60 * 60 * 1000);
    }
    async getSessionKey(channelId, cortexSessionKey, currentTokens) {
        const now = Date.now();
        const existing = this.sessions.get(channelId);
        // Detect Cortex-initiated reset
        const cortexGeneration = this.extractGeneration(cortexSessionKey);
        if (existing) {
            const existingGeneration = this.extractGeneration(existing.cortexSessionKey);
            let shouldReset = false;
            let resetReason = '';
            // 1. Check if Cortex reset the session
            if (cortexGeneration > existingGeneration) {
                shouldReset = true;
                resetReason = 'Cortex session reset';
            }
            // 2. Check if we're approaching token limits
            if (currentTokens && currentTokens > this.TOKEN_RESET_THRESHOLD) {
                shouldReset = true;
                resetReason = `Token limit exceeded (${currentTokens} tokens)`;
            }
            // 3. Check message count
            if (existing.messageCount > this.MESSAGE_RESET_THRESHOLD) {
                shouldReset = true;
                resetReason = `Message limit exceeded (${existing.messageCount} messages)`;
            }
            // 4. Check timeout
            if (now - existing.lastActivity > this.SESSION_TIMEOUT_MS) {
                shouldReset = true;
                resetReason = 'Session timeout';
            }
            if (shouldReset) {
                // Reset to new generation
                existing.generation++;
                existing.cortexSessionKey = cortexSessionKey;
                existing.openclawSessionKey = `cortex-channel-${channelId}-g${existing.generation}`;
                existing.lastActivity = now;
                existing.tokenCount = 0;
                existing.messageCount = 0;
                console.log(`[session-manager] Reset channel ${channelId}: ${resetReason}`);
                // If OpenClaw initiated the reset, we need to notify Cortex
                if (resetReason !== 'Cortex session reset') {
                    await this.notifyCortexReset(channelId, resetReason);
                    return {
                        sessionKey: existing.openclawSessionKey,
                        shouldNotifyReset: true,
                        resetReason
                    };
                }
            }
            else {
                // Continue with current session
                existing.lastActivity = now;
                existing.messageCount++;
                if (currentTokens)
                    existing.tokenCount = currentTokens;
                // Warn if approaching limits
                if (currentTokens && currentTokens > this.TOKEN_WARNING_THRESHOLD) {
                    console.log(`[session-manager] Warning: Channel ${channelId} at ${currentTokens} tokens`);
                }
            }
            return { sessionKey: existing.openclawSessionKey };
        }
        // New channel - create first generation
        const info = {
            channelId,
            generation: 1,
            cortexSessionKey,
            openclawSessionKey: `cortex-channel-${channelId}-g1`,
            lastActivity: now,
            tokenCount: 0,
            messageCount: 1
        };
        this.sessions.set(channelId, info);
        console.log(`[session-manager] Created new session for channel ${channelId}: ${info.openclawSessionKey}`);
        return { sessionKey: info.openclawSessionKey };
    }
    extractGeneration(cortexKey) {
        const match = cortexKey.match(/-s(\d+)$/);
        return match ? parseInt(match[1]) : 1;
    }
    async notifyCortexReset(channelId, reason) {
        // Tell Cortex to reset its session too
        try {
            const response = await fetch(`${this.apiUrl}/v1/chat/channels/${channelId}/session/reset`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.jwtToken}`
                },
                body: JSON.stringify({
                    reason,
                    initiatedBy: 'openclaw'
                })
            });
            if (!response.ok) {
                console.error(`[session-manager] Failed to notify Cortex of reset: ${response.status}`);
            }
            else {
                console.log(`[session-manager] Notified Cortex of session reset for channel ${channelId}`);
            }
        }
        catch (err) {
            console.error(`[session-manager] Error notifying Cortex: ${err.message}`);
        }
    }
    // Call this after each message to track token usage
    updateUsage(channelId, tokens, messages) {
        const session = this.sessions.get(channelId);
        if (session) {
            session.tokenCount = tokens;
            if (messages)
                session.messageCount = messages;
        }
    }
    getStats(channelId) {
        const session = this.sessions.get(channelId);
        if (!session)
            return null;
        return {
            generation: session.generation,
            tokens: session.tokenCount,
            messages: session.messageCount,
            tokenWarning: session.tokenCount > this.TOKEN_WARNING_THRESHOLD,
            tokenPercent: Math.round((session.tokenCount / this.TOKEN_RESET_THRESHOLD) * 100)
        };
    }
    // Task 4: Force sync method
    async forceReset(channelId, reason = 'Force sync') {
        const existing = this.sessions.get(channelId);
        const generation = existing ? existing.generation + 1 : 1;
        const newSession = {
            channelId,
            generation,
            cortexSessionKey: `cortex-channel-${channelId}-s${generation}`,
            openclawSessionKey: `cortex-channel-${channelId}-g${generation}`,
            lastActivity: Date.now(),
            tokenCount: 0,
            messageCount: 0
        };
        const oldKey = existing?.openclawSessionKey;
        this.sessions.set(channelId, newSession);
        // Notify Cortex
        await this.notifyCortexReset(channelId, reason);
        console.log(`[session-manager] Force reset channel ${channelId}: ${oldKey || 'none'} -> ${newSession.openclawSessionKey}`);
        return {
            newSessionKey: newSession.openclawSessionKey,
            oldSessionKey: oldKey
        };
    }
}
exports.BidirectionalSessionManager = BidirectionalSessionManager;
//# sourceMappingURL=session-manager-v3.js.map