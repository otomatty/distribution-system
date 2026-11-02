ALTER TABLE `purchase_orders` ADD `subtotal` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `tax` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_orders` ADD `total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `purchase_return_lines` ADD `purchase_order_line_id` text;--> statement-breakpoint
ALTER TABLE `purchase_return_lines` ADD `unit_price_centi` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `purchase_return_lines_order_line` ON `purchase_return_lines` (`purchase_order_line_id`);--> statement-breakpoint
ALTER TABLE `purchase_returns` ADD `purchase_order_id` text;--> statement-breakpoint
CREATE INDEX `purchase_returns_order` ON `purchase_returns` (`purchase_order_id`);--> statement-breakpoint
CREATE INDEX `purchase_returns_invoice` ON `purchase_returns` (`supplier_invoice_id`);--> statement-breakpoint
CREATE INDEX `receipt_lines_order_line` ON `receipt_lines` (`purchase_order_line_id`);