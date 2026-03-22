#!/usr/bin/env node

// CLI tool to force session sync
// Usage: 
//   node force-sync-cli.js                    # Sync all channels
//   node force-sync-cli.js --channel 17       # Sync specific channel
//   node force-sync-cli.js --reset-all        # Hard reset all sessions

const args = process.argv.slice(2);
const apiUrl = process.env.CORTEX_API_URL || 'http://localhost:3201';
const token = process.env.CORTEX_JWT_TOKEN;

if (!token) {
  console.error('Error: CORTEX_JWT_TOKEN environment variable required');
  process.exit(1);
}

async function forceSync(channelId) {
  const endpoint = channelId 
    ? `${apiUrl}/v1/admin/sessions/sync/${channelId}`
    : `${apiUrl}/v1/admin/sessions/sync`;
  
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        reason: 'Manual CLI force sync',
        force: true
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log('✅ Force sync completed:');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('❌ Force sync failed:', err.message);
    process.exit(1);
  }
}

// Parse arguments
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Force Session Sync Tool

Usage:
  node force-sync-cli.js                    # Sync all channels
  node force-sync-cli.js --channel 17       # Sync specific channel
  node force-sync-cli.js --reset-all        # Hard reset all sessions

Environment variables:
  CORTEX_API_URL    API URL (default: http://localhost:3201)
  CORTEX_JWT_TOKEN  Authentication token (required)
  `);
  process.exit(0);
}

const channelIndex = args.indexOf('--channel');
const channelId = channelIndex >= 0 ? args[channelIndex + 1] : null;

forceSync(channelId);