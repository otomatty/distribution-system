import { and, count, desc, eq, gte, inArray, type SQL } from "drizzle-orm";

import { JOB_TYPES, type JobStatus, type JobType } from "../../../../domain/jobs";
import type { JobFilter, JobStore, JobView } from "../../../../usecases/platform/jobs.port";
import type { Db } from "../../client";
import { employees, jobs } from "../../schema";

const ACTIVE: JobStatus[] = ["pending", "queued", "running"];

function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

const columns = {
  id: jobs.id,
  type: jobs.type,
  status: jobs.status,
  progress: jobs.progress,
  total: jobs.total,
  resultKey: jobs.resultKey,
  resultName: jobs.resultName,
  error: jobs.error,
  createdBy: jobs.createdBy,
  createdByName: employees.name,
  createdAt: jobs.createdAt,
  finishedAt: jobs.finishedAt,
};

type Row = Omit<JobView, "type"> & { type: string };

function toView(r: Row): JobView[] {
  return isJobType(r.type) ? [{ ...r, type: r.type }] : [];
}

function conditions(filter: JobFilter): SQL[] {
  const conds: SQL[] = [inArray(jobs.type, [...filter.types])];
  if (filter.createdBy !== undefined) conds.push(eq(jobs.createdBy, filter.createdBy));
  if (filter.status === "active") conds.push(inArray(jobs.status, ACTIVE));
  if (filter.status === "failed") conds.push(eq(jobs.status, "failed"));
  return conds;
}

export function jobStore(db: Db): JobStore {
  const select = () =>
    db.select(columns).from(jobs).leftJoin(employees, eq(employees.id, jobs.createdBy));
  return {
    list(filter, limit) {
      if (filter.types.length === 0) return [];
      return select()
        .where(and(...conditions(filter)))
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(limit)
        .all()
        .flatMap(toView);
    },
    get(id) {
      const r = select().where(eq(jobs.id, id)).get();
      return r ? toView(r)[0] : undefined;
    },
    counts(filter, since) {
      if (filter.types.length === 0) return { active: 0, failed: 0 };
      const base = conditions({ ...filter, status: undefined });
      const active =
        db
          .select({ n: count() })
          .from(jobs)
          .where(and(...base, inArray(jobs.status, ACTIVE)))
          .get()?.n ?? 0;
      const failed =
        db
          .select({ n: count() })
          .from(jobs)
          .where(and(...base, eq(jobs.status, "failed"), gte(jobs.updatedAt, since)))
          .get()?.n ?? 0;
      return { active, failed };
    },
    latest(type, status) {
      const r = select()
        .where(and(eq(jobs.type, type), status ? eq(jobs.status, status) : undefined))
        .orderBy(desc(jobs.createdAt), desc(jobs.id))
        .limit(1)
        .get();
      return r ? toView(r)[0] : undefined;
    },
  };
}
