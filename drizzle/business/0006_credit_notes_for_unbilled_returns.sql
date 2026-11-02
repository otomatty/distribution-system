CREATE TABLE `customer_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`refunded_on` text NOT NULL,
	`amount` integer NOT NULL,
	`memo` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `customer_refunds_payment` ON `customer_refunds` (`payment_id`,`cancelled`,`amount`);--> statement-breakpoint
CREATE INDEX `customer_refunds_customer_amount` ON `customer_refunds` (`customer_id`,`cancelled`,`amount`);--> statement-breakpoint
ALTER TABLE `customer_payments` ADD `sales_return_id` text;--> statement-breakpoint
CREATE INDEX `customer_payments_sales_return` ON `customer_payments` (`sales_return_id`);