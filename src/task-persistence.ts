/**
 * Task persistence and recovery for Cortex channel plugin.
 * 
 * Handles:
 * - Persisting active tasks to disk
 * - Recovering tasks after gateway restart
 * - Heartbeat mechanism for task health
 * - Orphaned task cleanup
 */

import { promises as fs } from 'fs';
import path from 'path';

const TASKS_DIR = path.join(process.env.HOME || '', '.openclaw', 'cortex-tasks');
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const TASK_TIMEOUT = 300000; // 5 minutes without heartbeat = dead task

interface PersistedTask {
  taskKey: string;
  botId: number;
  channelTaskId?: number;
  channelId: number;
  sessionKey: string;
  label: string;
  status: string;
  startedAt: number;
  lastHeartbeat: number;
  metadata: any;
}

export class TaskPersistenceManager {
  private tasks = new Map<string, PersistedTask>();
  private heartbeatTimer: NodeJS.Timer | null = null;
  private apiUrl: string;
  private token: string;
  private log: any;
  private socket: any | null = null;

  constructor(apiUrl: string, token: string, log?: any, socket?: any) {
    this.apiUrl = apiUrl;
    this.token = token;
    this.log = log;
    this.socket = socket;
  }

  async init() {
    // Ensure tasks directory exists
    await fs.mkdir(TASKS_DIR, { recursive: true });
    
    // Load persisted tasks
    await this.loadPersistedTasks();
    
    // Start heartbeat timer
    this.startHeartbeatTimer();
  }

  async shutdown() {
    this.stopHeartbeatTimer();
    // Persist all active tasks
    await this.persistAllTasks();
  }

  private async loadPersistedTasks() {
    try {
      const files = await fs.readdir(TASKS_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        
        try {
          const filePath = path.join(TASKS_DIR, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const task = JSON.parse(content) as PersistedTask;
          
          // Check if task is stale (no heartbeat for > timeout)
          const now = Date.now();
          if (now - task.lastHeartbeat > TASK_TIMEOUT) {
            this.log?.info?.(`Task ${task.taskKey} is stale, marking as failed`);
            await this.markTaskFailed(task, 'Task timed out - no heartbeat');
            await fs.unlink(filePath);
          } else {
            // Task is still within timeout window, recover it
            this.tasks.set(task.taskKey, task);
            this.log?.info?.(`Recovered task ${task.taskKey} (channel ${task.channelId})`);
          }
        } catch (err) {
          this.log?.error?.(`Failed to load task file ${file}:`, err);
        }
      }
    } catch (err) {
      this.log?.error?.('Failed to load persisted tasks:', err);
    }
  }

  async addTask(task: Omit<PersistedTask, 'startedAt' | 'lastHeartbeat'>) {
    const fullTask: PersistedTask = {
      ...task,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };
    
    this.tasks.set(task.taskKey, fullTask);
    await this.persistTask(fullTask);
    
    this.log?.info?.(`Added task ${task.taskKey} for tracking`);
  }

  async updateTask(taskKey: string, updates: Partial<PersistedTask>) {
    const task = this.tasks.get(taskKey);
    if (!task) return;
    
    Object.assign(task, updates);
    task.lastHeartbeat = Date.now();
    
    await this.persistTask(task);
  }

  async completeTask(taskKey: string, status: 'completed' | 'failed' = 'completed', error?: string) {
    const task = this.tasks.get(taskKey);
    if (!task) return;
    
    // Update bot task status
    await this.updateBotTaskStatus(task.taskKey, task.botId, status, error);
    
    // Update channel task if exists
    if (task.channelTaskId) {
      await this.updateChannelTaskStatus(task.channelTaskId, status);
    }
    
    // Emit realtime task update via socket
    if (this.socket?.connected && task.channelId) {
      this.socket.emit('tasks:updated', {
        channelId: task.channelId,
        taskId: task.channelTaskId,
        status: status === 'failed' ? 'cancelled' : status,
      });
    }
    
    // Remove from active tasks and delete persistence file
    this.tasks.delete(taskKey);
    await this.deleteTaskFile(taskKey);
    
    this.log?.info?.(`Task ${taskKey} marked as ${status}`);
  }

  private async persistTask(task: PersistedTask) {
    const filePath = path.join(TASKS_DIR, `${task.taskKey}.json`);
    await fs.writeFile(filePath, JSON.stringify(task, null, 2));
  }

  private async deleteTaskFile(taskKey: string) {
    const filePath = path.join(TASKS_DIR, `${taskKey}.json`);
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        this.log?.error?.(`Failed to delete task file for ${taskKey}:`, err);
      }
    }
  }

  private async persistAllTasks() {
    for (const task of this.tasks.values()) {
      await this.persistTask(task);
    }
  }

  private startHeartbeatTimer() {
    this.heartbeatTimer = setInterval(() => {
      this.checkTaskHealth();
    }, HEARTBEAT_INTERVAL);
  }

  private stopHeartbeatTimer() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async checkTaskHealth() {
    const now = Date.now();
    const staleTasks: string[] = [];
    
    for (const [taskKey, task] of this.tasks) {
      if (now - task.lastHeartbeat > TASK_TIMEOUT) {
        staleTasks.push(taskKey);
      }
    }
    
    // Mark stale tasks as failed
    for (const taskKey of staleTasks) {
      const task = this.tasks.get(taskKey)!;
      this.log?.warn?.(`Task ${taskKey} timed out, marking as failed`);
      await this.completeTask(taskKey, 'failed', 'Task timed out - no heartbeat');
    }
  }

  private async markTaskFailed(task: PersistedTask, error: string) {
    await this.updateBotTaskStatus(task.taskKey, task.botId, 'failed', error);
    if (task.channelTaskId) {
      await this.updateChannelTaskStatus(task.channelTaskId, 'cancelled');
    }
  }

  private async updateBotTaskStatus(taskKey: string, botId: number, status: string, error?: string) {
    try {
      const res = await fetch(`${this.apiUrl}/v1/bots/${botId}/tasks`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({
          taskKey,
          status,
          metadata: error ? { error } : {},
        }),
      });
      
      if (!res.ok) {
        this.log?.error?.(`Failed to update bot task status: ${res.status}`);
      }
    } catch (err) {
      this.log?.error?.('Error updating bot task status:', err);
    }
  }

  private async updateChannelTaskStatus(taskId: number, status: string) {
    try {
      const res = await fetch(`${this.apiUrl}/v1/chat/tasks/${taskId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
        },
        body: JSON.stringify({ status }),
      });
      
      if (!res.ok) {
        this.log?.error?.(`Failed to update channel task status: ${res.status}`);
      }
    } catch (err) {
      this.log?.error?.('Error updating channel task status:', err);
    }
  }

  // Called periodically to update heartbeat for active task
  async heartbeat(taskKey: string) {
    const task = this.tasks.get(taskKey);
    if (task) {
      task.lastHeartbeat = Date.now();
      await this.persistTask(task);
    }
  }

  // Get all active tasks (for monitoring/debugging)
  getActiveTasks(): PersistedTask[] {
    return Array.from(this.tasks.values());
  }

  // Cleanup orphaned tasks on startup
  async cleanupOrphanedTasks(botId: number) {
    try {
      // Query Cortex for running tasks
      const res = await fetch(`${this.apiUrl}/v1/bots/${botId}/tasks?status=running`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      
      if (!res.ok) {
        this.log?.error?.('Failed to query running tasks');
        return;
      }
      
      const data = await res.json();
      const runningTasks = data.tasks || [];
      
      // Mark orphaned tasks as failed
      for (const task of runningTasks) {
        if (task.taskKey && !this.tasks.has(task.taskKey)) {
          this.log?.info?.(`Found orphaned task ${task.taskKey}, marking as failed`);
          await this.updateBotTaskStatus(task.taskKey, botId, 'failed', 'Task orphaned - gateway restarted');
        }
      }
    } catch (err) {
      this.log?.error?.('Error cleaning up orphaned tasks:', err);
    }
  }
}