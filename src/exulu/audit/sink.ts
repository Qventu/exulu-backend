import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { AuditEvent } from "./event";
import type { ResolvedAuditConfig } from "./config";
import type { AuditWriter } from "./s3-writer";

export type SpoolStore = {
  write: (name: string, body: string) => Promise<void>;
  list: () => Promise<string[]>;
  read: (name: string) => Promise<string>;
  remove: (name: string) => Promise<void>;
};

export const createFsSpoolStore = (dir: string): SpoolStore => ({
  write: async (name, body) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), body, "utf8");
  },
  list: async () => {
    try { return (await fs.readdir(dir)).filter((f) => f.endsWith(".ndjson")); }
    catch { return []; }
  },
  read: async (name) => fs.readFile(path.join(dir, name), "utf8"),
  remove: async (name) => { await fs.rm(path.join(dir, name), { force: true }); },
});

const pad = (n: number) => String(n).padStart(2, "0");

export class AuditSink {
  private buffer: AuditEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private now: () => Date;

  constructor(
    private cfg: Pick<ResolvedAuditConfig, "target" | "flush" | "failureMode">,
    private writer: Pick<AuditWriter, "putNdjson">,
    private spool: SpoolStore,
    opts?: { now?: () => Date },
  ) {
    this.now = opts?.now ?? (() => new Date());
  }

  private objectKey(): string {
    const d = this.now();
    const dt = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    return `${this.cfg.target.s3prefix}dt=${dt}/${pad(d.getUTCHours())}/${Date.now()}-${randomUUID()}.ndjson`;
  }

  private serialize(events: AuditEvent[]): string {
    return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }

  record(event: AuditEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= this.cfg.flush.maxRecords) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.cfg.flush.maxIntervalMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const body = this.serialize(batch);
    try {
      await this.writer.putNdjson(this.objectKey(), body);
      await this.drainSpool();
    } catch (error) {
      const name = `${Date.now()}-${randomUUID()}.ndjson`;
      try {
        await this.spool.write(name, body);
        console.warn(`[EXULU] audit: S3 write failed, spooled ${batch.length} record(s) to disk (${name}).`, error);
      } catch (spoolError) {
        console.error(`[EXULU] audit: S3 write AND local spool failed — ${batch.length} record(s) lost.`, spoolError);
      }
    }
  }

  private async drainSpool(): Promise<void> {
    const names = await this.spool.list();
    for (const name of names) {
      try {
        const body = await this.spool.read(name);
        await this.writer.putNdjson(this.objectKey(), body);
        await this.spool.remove(name);
      } catch {
        return; // stop on first failure; retry on the next flush
      }
    }
  }

  async recordDurable(event: AuditEvent): Promise<void> {
    await this.writer.putNdjson(this.objectKey(), this.serialize([event]));
  }

  async close(): Promise<void> {
    await this.flush();
  }
}
