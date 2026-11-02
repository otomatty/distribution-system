CREATE INDEX `purchase_orders_ordered` ON `purchase_orders` (`ordered_on`,`number`);--> statement-breakpoint
CREATE INDEX `receipts_received` ON `receipts` (`received_on`);--> statement-breakpoint
CREATE INDEX `customer_payments_customer_amount` ON `customer_payments` (`customer_id`,`cancelled`,`amount`);--> statement-breakpoint
CREATE INDEX `invoices_issued` ON `invoices` (`issued_on`,`number`);--> statement-breakpoint
CREATE INDEX `payment_allocations_payment_amount` ON `payment_allocations` (`payment_id`,`cancelled`,`amount`);--> statement-breakpoint
CREATE INDEX `sales_orders_split_from` ON `sales_orders` (`split_from_id`);--> statement-breakpoint
CREATE INDEX `sales_orders_ship_planned` ON `sales_orders` (`ship_planned_on`,`number`);--> statement-breakpoint
CREATE INDEX `shipments_unbilled` ON `shipments` (`invoice_id`,`shipped_on`);--> statement-breakpoint
CREATE INDEX `documents_status` ON `documents` (`status`);