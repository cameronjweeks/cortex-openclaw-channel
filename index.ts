import { cortexPlugin } from "./src/channel.js";
import { setCortexRuntime } from "./src/runtime.js";

const plugin = {
  id: "cortex-channel",
  name: "Cortex Chat",
  description: "Cortex Chat channel plugin — connects to cortex-realtime via Socket.IO",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: any) {
    setCortexRuntime(api.runtime);
    api.registerChannel({ plugin: cortexPlugin });
  },
};

export default plugin;
