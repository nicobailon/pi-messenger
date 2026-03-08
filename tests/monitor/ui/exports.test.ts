import { describe, it, expect } from "vitest";

describe("monitor UI public exports", () => {
  it("does not export SessionMonitorPanel from monitor/ui", async () => {
    const monitorUi = await import("../../../src/monitor/ui/index.js");

    expect("SessionMonitorPanel" in monitorUi).toBe(false);
    expect("SessionMonitorPanelOptions" in monitorUi).toBe(false);
  });

  it("does not export SessionMonitorPanel from monitor", async () => {
    const monitor = await import("../../../src/monitor/index.js");

    expect("SessionMonitorPanel" in monitor).toBe(false);
    expect("SessionMonitorPanelOptions" in monitor).toBe(false);
  });
});
