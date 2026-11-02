ALTER TABLE `customer_payments` ADD `cancel_reason` text;--> statement-breakpoint
ALTER TABLE `customer_payments` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `customer_payments` ADD `cancelled_by` text;--> statement-breakpoint
ALTER TABLE `payment_allocations` ADD `cancel_reason` text;--> statement-breakpoint
ALTER TABLE `payment_allocations` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `payment_allocations` ADD `cancelled_by` text;--> statement-breakpoint
ALTER TABLE `sales_returns` ADD `cancel_reason` text;--> statement-breakpoint
ALTER TABLE `sales_returns` ADD `cancelled_at` text;--> statement-breakpoint
ALTER TABLE `sales_returns` ADD `cancelled_by` text;--> statement-breakpoint
UPDATE `customer_payments` SET `cancelled_at` = `updated_at`, `cancelled_by` = `updated_by`, `cancel_reason` = (SELECT json_extract(a.`after_json`, '$.reason') FROM `audit_logs` a WHERE a.`entity_type` = 'customer_payment' AND a.`entity_id` = `customer_payments`.`id` AND a.`action` = 'cancel' ORDER BY a.`occurred_at` DESC LIMIT 1) WHERE `cancelled` = 1;--> statement-breakpoint
UPDATE `sales_returns` SET `cancelled_at` = `updated_at`, `cancelled_by` = `updated_by`, `cancel_reason` = (SELECT json_extract(a.`after_json`, '$.reason') FROM `audit_logs` a WHERE a.`entity_type` = 'sales_return' AND a.`entity_id` = `sales_returns`.`id` AND a.`action` = 'cancel' ORDER BY a.`occurred_at` DESC LIMIT 1) WHERE `cancelled` = 1;--> statement-breakpoint
UPDATE `payment_allocations` SET `cancelled_at` = `updated_at`, `cancelled_by` = `updated_by`, `cancel_reason` = (SELECT '入金の取消：' || json_extract(a.`after_json`, '$.reason') FROM `audit_logs` a, json_each(a.`after_json`, '$.cancelledAllocationIds') j WHERE a.`entity_type` = 'customer_payment' AND a.`entity_id` = `payment_allocations`.`payment_id` AND a.`action` = 'cancel' AND j.`value` = `payment_allocations`.`id` LIMIT 1) WHERE `cancelled` = 1;
