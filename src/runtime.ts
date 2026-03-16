let _runtime: any = null;

export function setCortexRuntime(rt: any) {
  _runtime = rt;
}

export function getCortexRuntime(): any {
  if (!_runtime) throw new Error("Cortex runtime not initialized");
  return _runtime;
}
