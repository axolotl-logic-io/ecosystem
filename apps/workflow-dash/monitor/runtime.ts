import type { DatabaseConnection } from "@ecosystem/db";
import {
  type MonitorSnapshot,
  readSnapshot,
  type TranscriptPage,
  transcript,
} from "@ecosystem/db/monitoring";
import type { Config } from "../config.ts";
import { monitoringConnection } from "./connection.ts";

const refreshMilliseconds = 5000;
class MonitorRuntime {
  snapshot: MonitorSnapshot | null = null;
  error: string | null = null;
  page: TranscriptPage = { rows: [], more: false };
  session: string | null = null;
  following: boolean;
  changed: (() => void) | undefined;
  private connection: DatabaseConnection | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private pageGeneration = 0;
  private refreshing: Promise<void> | null = null;
  private repositories: string[] = [];
  private readonly connect: () => Promise<DatabaseConnection>;
  constructor(
    connect: () => Promise<DatabaseConnection> = (): Promise<DatabaseConnection> =>
      monitoringConnection("reader"),
  ) {
    this.connect = connect;
    this.following = true;
  }
  async start(config: Config): Promise<void> {
    const stopped = this.stop();
    const { generation } = this;
    await stopped;
    if (generation !== this.generation) {
      return;
    }
    this.repositories = config.repos;
    try {
      const connection = await this.connect();
      if (generation !== this.generation) {
        await connection.close();
        return;
      }
      this.connection = connection;
      await this.refresh();
    } catch {
      if (generation === this.generation) {
        this.error =
          "Monitoring unavailable · provision the reader connection and apply monitoring migrations";
      }
    }
    if (generation === this.generation) {
      this.timer = setInterval(() => {
        this.refresh().catch(() => null);
      }, refreshMilliseconds);
    }
  }
  async stop(): Promise<void> {
    this.generation += 1;
    this.pageGeneration += 1;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    const { connection } = this;
    this.connection = null;
    this.changed = undefined;
    this.refreshing = null;
    this.session = null;
    this.page = { rows: [], more: false };
    this.snapshot = null;
    if (connection !== null) {
      await connection.close();
    }
  }
  refresh(): Promise<void> {
    if (this.refreshing !== null) {
      return this.refreshing;
    }
    const { generation } = this;
    const work = this.collect(generation).finally((): void => {
      if (generation === this.generation) {
        this.refreshing = null;
      }
    });
    this.refreshing = work;
    return work;
  }
  private async collect(generation: number): Promise<void> {
    try {
      if (this.connection === null) {
        const connection = await this.connect();
        if (generation !== this.generation) {
          await connection.close();
          return;
        }
        this.connection = connection;
      }
      const snapshot = await readSnapshot(
        this.connection.db,
        this.repositories,
      );
      if (generation !== this.generation) {
        return;
      }
      this.snapshot = snapshot;
      this.error = null;
      if (this.session !== null && this.following) {
        await this.loadPage(this.session);
      }
    } catch {
      if (generation === this.generation) {
        this.error = "Database read failed · previous values retained";
      }
    }
    if (generation === this.generation) {
      this.changed?.();
    }
  }
  async loadPage(session: string, before?: number): Promise<void> {
    this.pageGeneration += 1;
    const request = this.pageGeneration;
    this.session = session;
    if (before !== undefined) {
      this.following = false;
    }
    try {
      if (this.connection === null) {
        return;
      }
      const page = await transcript(this.connection.db, session, before);
      if (request === this.pageGeneration) {
        this.page = page;
        this.changed?.();
      }
    } catch {
      if (request === this.pageGeneration) {
        this.error = "Transcript read failed · previous page retained";
        this.changed?.();
      }
    }
  }
}

export { MonitorRuntime };
