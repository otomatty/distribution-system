CREATE INDEX `customer_payments_customer_amount` ON `customer_payments` (`customer_id`,`cancelled`,`amount`);--> statement-breakpoint
CREATE INDEX `payment_allocations_payment_amount` ON `payment_allocations` (`payment_id`,`cancelled`,`amount`);--> statement-breakpoint
CREATE INDEX `documents_status` ON `documents` (`status`);