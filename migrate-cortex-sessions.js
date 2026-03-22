#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Configuration
const SUMMARIZE_THRESHOLD = 100; // Summarize if more than 100 messages
const DATABASE_URL = 'postgres://router:routerpass@localhost:5433/llm_router';

// Parse command line arguments
const args = process.argv.slice(2);
const options = {
  summarize: args.includes('--summarize'),
  dryRun: args.includes('--dry-run'),
  channel: args.find(a => a.startsWith('--channel='))?.split('=')[1],
  all: args.includes('--all')
};

if (!options.all && !options.channel) {
  console.log('Usage: node migrate-cortex-sessions.js [--all | --channel=ID] [--summarize] [--dry-run]');
  console.log('  --all          Migrate all channels');
  console.log('  --channel=ID   Migrate specific channel');
  console.log('  --summarize    Summarize long histories (>100 messages)');
  console.log('  --dry-run      Show what would be done without making changes');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Get all channels from database
async function getChannels() {
  const query = `
    SELECT c.id, c.name, COUNT(m.id) as message_count, c.current_session
    FROM channels c 
    LEFT JOIN messages m ON c.id = m.channel_id 
    WHERE c.archived_at IS NULL
    GROUP BY c.id, c.name, c.current_session
    ORDER BY COUNT(m.id) DESC
  `;
  
  const result = await pool.query(query);
  return result.rows;
}

// Get all messages for a channel
async function getChannelMessages(channelId) {
  const query = `
    SELECT 
      m.id,
      m.content,
      m.created_at,
      u.is_ai as is_ai_response,
      u.name as user_name,
      u.email as user_email
    FROM messages m
    JOIN users u ON m.user_id = u.id
    WHERE m.channel_id = $1 
      AND m.deleted_at IS NULL
      AND m.content IS NOT NULL
      AND m.content != ''
    ORDER BY m.created_at ASC
  `;
  
  const result = await pool.query(query, [channelId]);
  return result.rows;
}

// Create summary using OpenClaw subagent
async function createSummary(messages, channelName) {
  console.log(`  Creating AI summary for ${messages.length} messages...`);
  
  // Prepare the conversation history
  const history = messages.map(m => {
    const role = m.is_ai_response ? 'Assistant' : m.user_name;
    const timestamp = new Date(m.created_at).toISOString().split('T')[0];
    // Clean content to avoid shell escaping issues
    const content = m.content
      .replace(/["`$\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 500);
    return `[${timestamp}] ${role}: ${content}`;
  }).join('\n\n');
  
  // Save to temp file for processing
  const tempFile = `/tmp/channel-${channelName.replace(/[^a-z0-9]/gi, '-')}-history.txt`;
  const summaryPrompt = `Summarize this conversation history from the "${channelName}" channel. Focus on:
1. Main topics discussed
2. Key decisions made  
3. Action items or next steps
4. Important context that should be preserved

Conversation:
${history.substring(0, 30000)}${history.length > 30000 ? '\n\n[... truncated ...]' : ''}`;
  
  fs.writeFileSync(tempFile, summaryPrompt);
  
  try {
    // Use a file-based approach to avoid shell escaping issues
    const result = execSync(
      `openclaw --model claude-3-5-haiku-latest --no-stream < "${tempFile}"`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    
    fs.unlinkSync(tempFile);
    return result.trim();
  } catch (e) {
    console.error('  Failed to create summary:', e.message);
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    return null;
  }
}

// Export channel data
async function exportChannel(channel, messages, summary) {
  const exportDir = '/home/ubuntu/workspace/cortex-migrations';
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }
  
  // Create export data
  const exportData = {
    channel: {
      id: channel.id,
      name: channel.name,
      messageCount: messages.length,
      currentSession: channel.current_session,
      exportedAt: new Date().toISOString()
    },
    summary: summary,
    messages: messages.map(m => ({
      id: m.id,
      content: m.content,
      createdAt: m.created_at,
      isAi: m.is_ai_response,
      userName: m.user_name,
      userEmail: m.user_email
    }))
  };
  
  // Save JSON export
  const jsonFile = path.join(exportDir, `channel-${channel.id}-${channel.name.replace(/[^a-z0-9]/gi, '-')}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(exportData, null, 2));
  
  // Save markdown export
  const mdFile = path.join(exportDir, `channel-${channel.id}-${channel.name.replace(/[^a-z0-9]/gi, '-')}.md`);
  const mdContent = `# ${channel.name} - Channel Migration Export

**Channel ID:** ${channel.id}  
**Total Messages:** ${messages.length}  
**Exported:** ${new Date().toISOString()}

## Summary

${summary || 'No summary generated.'}

## Full History

${messages.map(m => {
  const role = m.is_ai_response ? 'Assistant' : m.user_name;
  const timestamp = new Date(m.created_at).toISOString();
  return `### [${timestamp}] ${role}\n\n${m.content}\n`;
}).join('\n---\n\n')}
`;
  
  fs.writeFileSync(mdFile, mdContent);
  
  return { jsonFile, mdFile };
}

// Update channel to use new session
async function updateChannelSession(channelId, newSessionKey) {
  const query = `
    UPDATE channels 
    SET 
      current_session = $1,
      last_reset_at = NOW(),
      last_reset_reason = 'Migration to stable session management'
    WHERE id = $2
  `;
  
  await pool.query(query, [newSessionKey, channelId]);
}

// Process a single channel
async function processChannel(channel) {
  console.log(`\nProcessing Channel #${channel.id}: ${channel.name}`);
  console.log(`  Current messages: ${channel.message_count}`);
  
  // Get all messages
  const messages = await getChannelMessages(channel.id);
  console.log(`  Retrieved ${messages.length} messages`);
  
  if (messages.length === 0) {
    console.log('  No messages to migrate');
    return null;
  }
  
  // Create summary if needed
  let summary = null;
  if (options.summarize && messages.length > SUMMARIZE_THRESHOLD) {
    summary = await createSummary(messages, channel.name);
  }
  
  // New session key format
  const newSessionKey = `cortex-channel-${channel.id}-g1`;
  
  if (options.dryRun) {
    console.log(`  [DRY RUN] Would export ${messages.length} messages`);
    console.log(`  [DRY RUN] Would set session to: ${newSessionKey}`);
    if (summary) {
      console.log('  [DRY RUN] Would create summary');
    }
  } else {
    // Export data
    const { jsonFile, mdFile } = await exportChannel(channel, messages, summary);
    console.log(`  Exported to: ${jsonFile}`);
    console.log(`  Markdown: ${mdFile}`);
    
    // Update channel session
    await updateChannelSession(channel.id, newSessionKey);
    console.log(`  Updated session to: ${newSessionKey}`);
  }
  
  return {
    channelId: channel.id,
    channelName: channel.name,
    messageCount: messages.length,
    summarized: !!summary,
    newSessionKey
  };
}

// Main execution
async function main() {
  console.log('Cortex Session Migration Tool');
  console.log('=============================');
  console.log(`Options: ${JSON.stringify(options)}\n`);
  
  try {
    // Get channels
    const channels = await getChannels();
    console.log(`Found ${channels.length} channels`);
    
    // Filter channels if specific one requested
    let targetChannels;
    if (options.channel) {
      const channelId = parseInt(options.channel);
      targetChannels = channels.filter(c => c.id === channelId);
      if (targetChannels.length === 0) {
        console.error(`Channel ${channelId} not found`);
        process.exit(1);
      }
    } else {
      targetChannels = channels;
    }
    
    // Process each channel
    const results = [];
    for (const channel of targetChannels) {
      try {
        const result = await processChannel(channel);
        if (result) results.push(result);
      } catch (e) {
        console.error(`  Error processing channel ${channel.id}:`, e.message);
      }
    }
    
    // Summary
    console.log('\n=== Migration Summary ===');
    console.log(`Channels processed: ${results.length}`);
    console.log(`Total messages: ${results.reduce((sum, r) => sum + r.messageCount, 0)}`);
    console.log(`Summarized: ${results.filter(r => r.summarized).length}`);
    
    if (!options.dryRun) {
      console.log('\nMigration complete!');
      console.log('Exported data saved to: ~/workspace/cortex-migrations/');
      console.log('\nChannels now use stable session format (g1)');
      console.log('Future messages will maintain session continuity.');
    }
    
  } finally {
    await pool.end();
  }
}

// Run
main().catch(console.error);