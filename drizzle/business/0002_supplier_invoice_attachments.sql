CREATE TABLE `supplier_invoice_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_invoice_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`file_name` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_invoice_attachments_invoice` ON `supplier_invoice_attachments` (`supplier_invoice_id`);