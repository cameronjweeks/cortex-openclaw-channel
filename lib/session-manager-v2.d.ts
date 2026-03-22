declare class HybridSessionManager {
    private sessions;
    private SESSION_TIMEOUT_MS;
    getSessionKey(channelId: number, cortexSessionKey: string): string;
    private extractGeneration;
    updateTokenCount(channelId: number, tokens: number): void;
}
export declare const sessionManager: HybridSessionManager;
export {};
//# sourceMappingURL=session-manager-v2.d.ts.map