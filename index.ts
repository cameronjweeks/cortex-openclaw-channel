import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/core';
import { cortexPlugin } from './src/channel.js';
import { setCortexRuntime } from './src/runtime.js';

export { cortexPlugin } from './src/channel.js';
export { setCortexRuntime } from './src/runtime.js';

export default defineChannelPluginEntry({
  id: 'cortex-channel',
  name: 'Cortex Chat',
  description: 'Cortex Chat channel plugin — connects to cortex-realtime via Socket.IO',
  plugin: cortexPlugin,
  setRuntime: setCortexRuntime,
});
