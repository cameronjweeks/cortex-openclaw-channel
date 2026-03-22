"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setCortexRuntime = setCortexRuntime;
exports.getCortexRuntime = getCortexRuntime;
let _runtime = null;
function setCortexRuntime(rt) {
    _runtime = rt;
}
function getCortexRuntime() {
    if (!_runtime)
        throw new Error("Cortex runtime not initialized");
    return _runtime;
}
//# sourceMappingURL=runtime.js.map