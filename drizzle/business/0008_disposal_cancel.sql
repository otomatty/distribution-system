ALTER TABLE `disposals` ADD `cancelled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `disposals` ADD `cancel_reason` text;--> statement-breakpoint
ALTER TABLE `disposals` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `disposals` ADD `cancelled_by` text;