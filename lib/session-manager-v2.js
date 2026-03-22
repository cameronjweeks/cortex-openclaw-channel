"use strict";
// ─── Session Management V2 - Hybrid Approach ──────────
// Stable sessions within a "generation", reset when Cortex explicitly resets
Object.defineProperty(exports, "__esModule", { value: true });
exports.sessionManager = void 0;
class HybridSessionManager {
    constructor() {
        this.sessions = new Map();
        this.SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;
    }
    getSessionKey(channelId, cortexSessionKey) {
        const now = Date.now();
        const existing = this.sessions.get(channelId);
        // Detect Cortex session reset (e.g., s1 -> s2)
        const cortexGeneration = this.extractGeneration(cortexSessionKey);
        if (existing) {
            const existingGeneration = this.extractGeneration(existing.cortexSessionKey);
            // Check if Cortex incremented the session number
            if (cortexGeneration > existingGeneration) {
                // Cortex reset - honor it
                console.log(`[session-manager] Cortex reset detected for channel ${channelId}: gen ${existingGeneration} -> ${cortexGeneration}`);
                existing.generation++;
                existing.cortexSessionKey = cortexSessionKey;
                existing.openclawSessionKey = `cortex-channel-${channelId}-g${existing.generation}`;
                existing.lastActivity = now;
                existing.tokenCount = 0;
            }
            else {
                // Same generation - maintain stable session
                existing.lastActivity = now;
                existing.cortexSessionKey = cortexSessionKey;
            }
            return existing.openclawSessionKey;
        }
        // New channel - create first generation
        const info = {
            channelId,
            generation: 1,
            cortexSessionKey,
            openclawSessionKey: `cortex-channel-${channelId}-g1`,
            lastActivity: now
        };
        this.sessions.set(channelId, info);
        console.log(`[session-manager] Created new session for channel ${channelId}: ${info.openclawSessionKey}`);
        return info.openclawSessionKey;
    }
    extractGeneration(cortexKey) {
        // Extract number from patterns like "cortex-channel-17-s3"
        const match = cortexKey.match(/-s(\d+)$/);
        return match ? parseInt(match[1]) : 1;
    }
    updateTokenCount(channelId, tokens) {
        const session = this.sessions.get(channelId);
        if (session) {
            session.tokenCount = tokens;
        }
    }
}
exports.sessionManager = new HybridSessionManager();
//# sourceMappingURL=session-manager-v2.js.map