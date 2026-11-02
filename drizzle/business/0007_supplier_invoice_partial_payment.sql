ALTER TABLE `supplier_invoices` ADD `paid_amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `supplier_invoices` SET `paid_amount` = coalesce((SELECT sum(p.`amount`) FROM `supplier_payments` p WHERE p.`supplier_invoice_id` = `supplier_invoices`.`id` AND p.`cancelled` = 0), 0);
