interface SessionInfo {
    channelId: number;
    generation: number;
    cortexSessionKey: string;
    openclawSessionKey: string;
    lastActivity: number;
    tokenCount: number;
    messageCount: number;
}
interface SessionConfig {
    tokenWarningThreshold?: number;
    tokenResetThreshold?: number;
    messageResetThreshold?: number;
    sessionTimeoutMs?: number;
}
declare class BidirectionalSessionManager {
    private apiUrl;
    private jwtToken;
    private sessions;
    private TOKEN_WARNING_THRESHOLD;
    private TOKEN_RESET_THRESHOLD;
    private MESSAGE_RESET_THRESHOLD;
    private SESSION_TIMEOUT_MS;
    constructor(apiUrl: string, jwtToken: string, config?: SessionConfig);
    getSessionKey(channelId: number, cortexSessionKey: string, currentTokens?: number): Promise<{
        sessionKey: string;
        shouldNotifyReset?: boolean;
        resetReason?: string;
    }>;
    private extractGeneration;
    private notifyCortexReset;
    updateUsage(channelId: number, tokens: number, messages?: number): void;
    getStats(channelId: number): {
        generation: number;
        tokens: number;
        messages: number;
        tokenWarning: boolean;
        tokenPercent: number;
    } | null;
    forceReset(channelId: number, reason?: string): Promise<{
        newSessionKey: string;
        oldSessionKey?: string;
    }>;
}
export { BidirectionalSessionManager, SessionInfo };
export type { SessionConfig };
//# sourceMappingURL=session-manager-v3.d.ts.map