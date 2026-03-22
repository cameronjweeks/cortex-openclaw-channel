// Status management for rich AI indicators

export class StatusManager {
  private socket: any;
  private channelId: number;
  private currentTimer: any = null;
  private lastStatus: string | null = null;
  
  constructor(socket: any, channelId: number) {
    this.socket = socket;
    this.channelId = channelId;
  }
  
  private clearTimer() {
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
  
  stopTyping() {
    this.clearTimer();
    this.socket.emit("typing:stop", { channelId: this.channelId });
  }
  
  updateStatus(status: string, detail?: string) {
    this.clearTimer();
    
    // Map internal statuses to user-friendly ones
    const statusMap: Record<string, string> = {
      "tool_use": "working",
      "thinking": "thinking", 
      "browsing": "browsing",
      "coding": "coding",
      "searching": "searching",
      "analyzing": "analyzing",
      "reading": "reading",
      "writing": "writing",
      "web_search": "searching",
      "web_fetch": "browsing", 
      "browser": "browsing",
      "exec": "working",
      "process": "working",
      "read": "reading",
      "write": "writing",
      "edit": "writing",
      "image": "analyzing",
      "pdf": "reading",
      "lcm_grep": "searching",
      "lcm_expand": "reading",
      "memory_recall": "searching",
      "sessions_spawn": "working"
    };
    
    const mappedStatus = statusMap[status] || status;
    this.lastStatus = mappedStatus;
    
    this.socket.emit("ai:status", {
      channelId: this.channelId,
      status: mappedStatus,
      detail: detail || null,
      user: { name: "Bob", email: "bob@backv.co" }
    });
    
    // Auto-clear after 30 seconds
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