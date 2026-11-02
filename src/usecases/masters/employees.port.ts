import type { Role } from "../../domain/roles";
import type { WriteMeta } from "../ports";

export interface EmployeeRecord {
  readonly id: string;
  readonly authUserId: string | null;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly Role[];
  readonly active: boolean;
  readonly version: number;
}

export interface EmployeeStore {
  get(id: string): EmployeeRecord | undefined;
  findByEmail(email: string): EmployeeRecord | undefined;
  findByAuthUserId(authUserId: string): EmployeeRecord | undefined;
  list(): EmployeeRecord[];
  insert(record: Omit<EmployeeRecord, "version">, meta: WriteMeta): void;
  update(
    id: string,
    expectedVersion: number,
    patch: Partial<Pick<EmployeeRecord, "name" | "roles" | "active" | "authUserId">>,
    meta: WriteMeta,
  ): boolean;
}
