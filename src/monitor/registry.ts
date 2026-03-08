import { SessionStore } from "./store/session-store.js";
import { SessionEventEmitter } from "./events/emitter.js";
import type { SessionEvent } from "./events/types.js";
import { SessionLifecycleManager } from "./lifecycle/manager.js";
import { SessionMetricsAggregator } from "./metrics/aggregator.js";
import { OperatorCommandHandler } from "./commands/handler.js";
import { SessionHealthMonitor } from "./health/monitor.js";
import { SessionReplayer } from "./replay/replayer.js";
import { SessionExporter } from "./export/exporter.js";
import { SessionFeedSubscriber } from "./feed/subscriber.js";

export class MonitorRegistry {
  readonly store: SessionStore;
  readonly emitter: SessionEventEmitter;
  readonly lifecycle: SessionLifecycleManager;
  readonly aggregator: SessionMetricsAggregator;
  readonly commandHandler: OperatorCommandHandler;
  readonly healthMonitor: SessionHealthMonitor;
  readonly replayer: SessionReplayer;
  readonly exporter: SessionExporter;
  readonly feedSubscriber: SessionFeedSubscriber;

  private disposed = false;

  constructor() {
    this.store = new SessionStore();
    this.emitter = new SessionEventEmitter();
    this.lifecycle = new SessionLifecycleManager(this.store, this.emitter);
    this.aggregator = new SessionMetricsAggregator(this.emitter, this.store);
    this.commandHandler = new OperatorCommandHandler(this.lifecycle);
    this.healthMonitor = new SessionHealthMonitor(this.store, this.emitter, this.aggregator);
    this.replayer = new SessionReplayer(this.emitter, this.aggregator);
    this.exporter = new SessionExporter(
      (id) => this.store.get(id),
      (id) => this.emitter.getHistory().filter((event: SessionEvent) => event.sessionId === id),
    );
    this.feedSubscriber = new SessionFeedSubscriber(this.emitter);
    this.feedSubscriber.subscribe();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.healthMonitor.stop();
    this.feedSubscriber.unsubscribe();
    this.aggregator.destroy();
  }
}

export function createMonitorRegistry(): MonitorRegistry {
  return new MonitorRegistry();
}
