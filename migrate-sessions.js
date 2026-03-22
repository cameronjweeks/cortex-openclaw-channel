#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const SUMMARIZE_THRESHOLD = 100; // Summarize if more than 100 messages
const SESSION_DIR = '/home/ubuntu/.openclaw/agents/main/sessions';
const LCM_MODEL = 'claude-3-5-haiku-latest';

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  summarize: args.includes('--summarize'),
  dryRun: args.includes('--dry-run'),
  channel: args.find(a => a.startsWith('--channel='))?.split('=')[1],
  all: args.includes('--all')
};

if (!options.all && !options.channel) {
  console.log('Usage: node migrate-sessions.js [--all | --channel=ID] [--summarize] [--dry-run]');
  console.log('  --all          Migrate all channels');
  console.log('  --channel=ID   Migrate specific channel');
  console.log('  --summarize    Summarize long histories (>100 messages)');
  console.log('  --dry-run      Show what would be done without making changes');
  process.exit(1);
}

// Find all session files
function findSessionFiles() {
  const files = fs.readdirSync(SESSION_DIR);
  return files.filter(f => f.endsWith('.jsonl'));
}

// Extract channel ID from session key
function extractChannelId(sessionKey) {
  // Match patterns like cortex-channel-17, cortex-channel-17-s2
  const match = sessionKey.match(/cortex-channel-(\d+)(?:-s\d+)?/);
  return match ? parseInt(match[1]) : null;
}

// Parse JSONL file
function parseSessionFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

// Group sessions by channel
function groupSessionsByChannel(files) {
  const channels = new Map();
  
  files.forEach(file => {
    // Extract session key from filename
    const match = file.match(/^[a-f0-9-]+-topic-\d+\.\d+\.jsonl$/);
    if (!match) return;
    
    const sessionPath = path.join(SESSION_DIR, file);
    const messages = parseSessionFile(sessionPath);
    
    // Find channel ID from messages
    messages.forEach(msg => {
      if (msg.type === 'message' && msg.message?.SessionKey) {
        const channelId = extractChannelId(msg.message.SessionKey);
        if (channelId) {
          if (!channels.has(channelId)) {
            channels.set(channelId, []);
          }
          channels.get(channelId).push({
            file,
            sessionKey: msg.message.SessionKey,
            messages: messages.filter(m => 
              m.type === 'message' && 
              m.message?.role === 'user' &&
              m.message?.content?.[0]?.text
            )
          });
        }
      }
    });
  });
  
  return channels;
}

// Merge messages chronologically
function mergeMessages(sessions) {
  const allMessages = [];
  
  sessions.forEach(session => {
    session.messages.forEach(msg => {
      if (msg.message?.content?.[0]?.text) {
        allMessages.push({
          timestamp: msg.timestamp,
          text: msg.message.content[0].text,
          sessionKey: session.sessionKey
        });
      }
    });
  });
  
  // Sort by timestamp
  allMessages.sort((a, b) => 
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
  
  return allMessages;
}

// Create summary using LCM
async function summarizeHistory(messages, channelId) {
  console.log(`  Creating summary for ${messages.length} messages...`);
  
  // Create a temporary file with the history
  const tempFile = `/tmp/cortex-channel-${channelId}-history.md`;
  const content = messages.map(m => 
    `[${new Date(m.timestamp).toISOString()}] ${m.text}`
  ).join('\n\n');
  
  fs.writeFileSync(tempFile, content);
  
  // Use LCM to summarize
  try {
    const summary = execSync(`openclaw lcm summarize "${tempFile}" --model ${LCM_MODEL}`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });
    
    fs.unlinkSync(tempFile);
    return summary.trim();
  } catch (e) {
    console.error('  Failed to summarize:', e.message);
    fs.unlinkSync(tempFile);
    return null;
  }
}

// Create migration report
function createMigrationReport(channelId, sessions, messages, summary) {
  const report = {
    channelId,
    fragmentedSessions: sessions.map(s => s.sessionKey),
    totalMessages: messages.length,
    dateRange: messages.length > 0 ? {
      from: messages[0].timestamp,
      to: messages[messages.length - 1].timestamp
    } : null,
    summarized: !!summary,
    newSessionKey: `cortex-channel-${channelId}-g1`
  };
  
  return report;
}

// Main migration function
async function migrateChannel(channelId, sessions) {
  console.log(`\nMigrating Channel ${channelId}:`);
  console.log(`  Found ${sessions.length} fragmented sessions`);
  
  // Merge all messages
  const messages = mergeMessages(sessions);
  console.log(`  Total messages: ${messages.length}`);
  
  if (messages.length === 0) {
    console.log('  No messages to migrate');
    return null;
  }
  
  // Summarize if needed
  let summary = null;
  if (options.summarize && messages.length > SUMMARIZE_THRESHOLD) {
    summary = await summarizeHistory(messages, channelId);
  }
  
  // Create migration report
  const report = createMigrationReport(channelId, sessions, messages, summary);
  
  if (options.dryRun) {
    console.log('  [DRY RUN] Would migrate to:', report.newSessionKey);
    if (summary) {
      console.log('  [DRY RUN] Would create summary');
    }
  } else {
    // Save migration data
    const exportDir = '/home/ubuntu/workspace/cortex-migrations';
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    // Save full history
    const historyFile = path.join(exportDir, `channel-${channelId}-history.json`);
    fs.writeFileSync(historyFile, JSON.stringify({
      report,
      messages,
      summary
    }, null, 2));
    
    // Save summary separately if created
    if (summary) {
      const summaryFile = path.join(exportDir, `channel-${channelId}-summary.md`);
      fs.writeFileSync(summaryFile, summary);
    }
    
    console.log(`  Saved to: ${historyFile}`);
  }
  
  return report;
}

// Main execution
async function main() {
  console.log('Cortex Session Migration Tool');
  console.log('=============================');
  console.log(`Options: ${JSON.stringify(options)}\n`);
  
  const files = findSessionFiles();
  console.log(`Found ${files.length} session files`);
  
  const channels = groupSessionsByChannel(files);
  console.log(`Found ${channels.size} channels with fragmented sessions`);
  
  // Filter channels if specific one requested
  let targetChannels;
  if (options.channel) {
    const channelId = parseInt(options.channel);
    if (channels.has(channelId)) {
      targetChannels = new Map([[channelId, channels.get(channelId)]]);
    } else {
      console.error(`Channel ${channelId} not found`);
      process.exit(1);
    }
  } else {
    targetChannels = channels;
  }
  
  // Migrate each channel
  const results = [];
  for (const [channelId, sessions] of targetChannels) {
    const result = await migrateChannel(channelId, sessions);
    if (result) results.push(result);
  }
  
  // Summary
  console.log('\n=== Migration Summary ===');
  console.log(`Channels processed: ${results.length}`);
  console.log(`Total messages: ${results.reduce((sum, r) => sum + r.totalMessages, 0)}`);
  console.log(`Summarized: ${results.filter(r => r.summarized).length}`);
  
  if (!options.dryRun) {
    console.log('\nMigration data saved to: ~/workspace/cortex-migrations/');
    console.log('\nNext steps:');
    console.log('1. Review the migration files');
    console.log('2. Use the import tool to create new stable sessions');
    console.log('3. Update Cortex to use the new session keys');
  }
}

// Run
main().catch(console.error);