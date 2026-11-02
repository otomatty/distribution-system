CREATE INDEX `purchase_orders_ordered` ON `purchase_orders` (`ordered_on`,`number`);--> statement-breakpoint
CREATE INDEX `receipts_received` ON `receipts` (`received_on`);--> statement-breakpoint
CREATE INDEX `invoices_issued` ON `invoices` (`issued_on`,`number`);--> statement-breakpoint
CREATE INDEX `sales_orders_ship_planned` ON `sales_orders` (`ship_planned_on`,`number`);--> statement-breakpoint
CREATE INDEX `shipments_unbilled` ON `shipments` (`invoice_id`,`shipped_on`);