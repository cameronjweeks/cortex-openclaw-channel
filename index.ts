import { cortexPlugin, __getCortexApiUrl, __getCortexJwtToken } from "./src/channel.js";
import { setCortexRuntime } from "./src/runtime.js";
import { createChannelTaskTools } from "./src/tools.js";

const plugin = {
  id: "cortex-channel",
  name: "Cortex Chat",
  description: "Cortex Chat channel plugin — connects to cortex-realtime via Socket.IO and exposes channel_tasks_* tools to agents.",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: any) {
    setCortexRuntime(api.runtime);
    api.registerChannel({ plugin: cortexPlugin });

    // Register the task-management tools. These read apiUrl + JWT from
    // channel.ts module state at execute time (they aren't ready at
    // register time since the channel hasn't connected yet).
    const tools = createChannelTaskTools({
      getApiUrl: __getCortexApiUrl,
      getToken: __getCortexJwtToken,
    });
    for (const t of tools) {
      api.registerTool(t.def, t.opts);
    }
  },
};

export default plugin;
