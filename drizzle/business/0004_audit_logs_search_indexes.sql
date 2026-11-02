CREATE INDEX `audit_logs_employee` ON `audit_logs` (`employee_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_action` ON `audit_logs` (`action`,`occurred_at`);