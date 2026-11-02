CREATE TABLE `company_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`registration_number` text,
	`postal_code` text,
	`address` text,
	`phone` text,
	`fax` text,
	`email` text,
	`bank_info` text,
	`rounding_mode` text DEFAULT 'floor' NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `employees` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_user_id` text,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`roles` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employees_email` ON `employees` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `employees_auth_user` ON `employees` (`auth_user_id`);--> statement-breakpoint
CREATE TABLE `genres` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`jan` text,
	`name` text NOT NULL,
	`supplier_id` text NOT NULL,
	`genre_id` text,
	`temperature_zone` text DEFAULT 'ambient' NOT NULL,
	`tax_category` text NOT NULL,
	`purchase_unit_name` text NOT NULL,
	`sales_unit_name` text NOT NULL,
	`units_per_purchase_unit` integer DEFAULT 1 NOT NULL,
	`purchase_price_centi` integer NOT NULL,
	`sales_price_centi` integer NOT NULL,
	`purchase_min_lot` integer DEFAULT 1 NOT NULL,
	`sales_min_lot` integer DEFAULT 1 NOT NULL,
	`lead_time_days` integer,
	`reorder_enabled` integer DEFAULT false NOT NULL,
	`reorder_point` integer DEFAULT 0 NOT NULL,
	`purchase_shipping_note` text,
	`sales_shipping_note` text,
	`input_price_on_order` integer DEFAULT false NOT NULL,
	`memo` text,
	`discontinued` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_code` ON `items` (`code`);--> statement-breakpoint
CREATE INDEX `items_supplier` ON `items` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `items_genre` ON `items` (`genre_id`);--> statement-breakpoint
CREATE INDEX `items_jan` ON `items` (`jan`);--> statement-breakpoint
CREATE TABLE `locations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`contact_name` text,
	`postal_code` text,
	`address` text,
	`phone` text,
	`mobile` text,
	`fax` text,
	`email` text,
	`line_id` text,
	`main_contact` text,
	`memo` text,
	`display_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `partners` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kana` text NOT NULL,
	`honorific` text DEFAULT '御中' NOT NULL,
	`is_supplier` integer DEFAULT false NOT NULL,
	`is_customer` integer DEFAULT false NOT NULL,
	`contact_name` text,
	`postal_code` text,
	`address` text,
	`phone` text,
	`mobile` text,
	`fax` text,
	`email` text,
	`line_id` text,
	`main_contact` text,
	`registration_number` text,
	`closing_day` integer,
	`payment_month_offset` integer,
	`payment_day` integer,
	`delivery_days` integer DEFAULT 0 NOT NULL,
	`default_send_method` text DEFAULT 'none' NOT NULL,
	`order_method_note` text,
	`receive_method_note` text,
	`mail_order_allowed` integer DEFAULT false NOT NULL,
	`place_name` text,
	`memo` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `partners_kana` ON `partners` (`kana`);--> statement-breakpoint
CREATE TABLE `stores` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tax_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`category` text NOT NULL,
	`rate_bps` integer NOT NULL,
	`effective_from` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_rates_category_from` ON `tax_rates` (`category`,`effective_from`);--> statement-breakpoint
CREATE TABLE `purchase_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_order_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_centi` integer NOT NULL,
	`units_per_purchase_unit` integer NOT NULL,
	`tax_category` text NOT NULL,
	`received_quantity` integer DEFAULT 0 NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`memo` text
);
--> statement-breakpoint
CREATE INDEX `purchase_order_lines_order` ON `purchase_order_lines` (`purchase_order_id`);--> statement-breakpoint
CREATE INDEX `purchase_order_lines_item` ON `purchase_order_lines` (`item_id`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`supplier_id` text NOT NULL,
	`status` text NOT NULL,
	`ordered_on` text NOT NULL,
	`supplier_contact_name` text,
	`destination_kind` text NOT NULL,
	`destination_location_id` text,
	`destination_customer_id` text,
	`destination_address` text,
	`employee_id` text,
	`delivery_requested_on` text,
	`payment_due_on` text,
	`send_method` text DEFAULT 'none' NOT NULL,
	`sales_order_id` text,
	`memo` text,
	`cancel_reason` text,
	`confirmed_at` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_number` ON `purchase_orders` (`number`);--> statement-breakpoint
CREATE INDEX `purchase_orders_status` ON `purchase_orders` (`status`,`ordered_on`);--> statement-breakpoint
CREATE INDEX `purchase_orders_supplier` ON `purchase_orders` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `purchase_return_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`purchase_return_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`amount` integer NOT NULL,
	`tax_category` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `purchase_return_lines_return` ON `purchase_return_lines` (`purchase_return_id`);--> statement-breakpoint
CREATE TABLE `purchase_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`supplier_id` text NOT NULL,
	`returned_on` text NOT NULL,
	`location_id` text NOT NULL,
	`supplier_invoice_id` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`memo` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `purchase_returns_supplier` ON `purchase_returns` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `receipt_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`purchase_order_line_id` text NOT NULL,
	`item_id` text NOT NULL,
	`accepted` integer NOT NULL,
	`returned` integer NOT NULL,
	`closed_remaining` integer DEFAULT false NOT NULL,
	`unit_price_centi` integer NOT NULL,
	`units_per_purchase_unit` integer NOT NULL,
	`tax_category` text NOT NULL,
	`amount` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `receipt_lines_receipt` ON `receipt_lines` (`receipt_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`purchase_order_id` text NOT NULL,
	`received_on` text NOT NULL,
	`location_id` text,
	`supplier_invoice_id` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`memo` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `receipts_order` ON `receipts` (`purchase_order_id`);--> statement-breakpoint
CREATE INDEX `receipts_invoice` ON `receipts` (`supplier_invoice_id`);--> statement-breakpoint
CREATE TABLE `supplier_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`invoice_number` text,
	`invoice_date` text NOT NULL,
	`invoiced_amount` integer NOT NULL,
	`shipping_fee` integer DEFAULT 0 NOT NULL,
	`computed_amount` integer NOT NULL,
	`difference` integer DEFAULT 0 NOT NULL,
	`difference_reason` text,
	`payment_due_on` text,
	`status` text NOT NULL,
	`attachment_key` text,
	`cancel_reason` text,
	`memo` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_invoices_supplier` ON `supplier_invoices` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `supplier_invoices_due` ON `supplier_invoices` (`status`,`payment_due_on`);--> statement-breakpoint
CREATE TABLE `supplier_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_invoice_id` text NOT NULL,
	`paid_on` text NOT NULL,
	`amount` integer NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`memo` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `supplier_payments_invoice` ON `supplier_payments` (`supplier_invoice_id`);--> statement-breakpoint
CREATE TABLE `customer_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`received_on` text NOT NULL,
	`amount` integer NOT NULL,
	`method` text NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL,
	`memo` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `customer_payments_customer` ON `customer_payments` (`customer_id`,`received_on`);--> statement-breakpoint
CREATE TABLE `disposal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`disposal_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE INDEX `disposal_lines_disposal` ON `disposal_lines` (`disposal_id`);--> statement-breakpoint
CREATE INDEX `disposal_lines_item` ON `disposal_lines` (`item_id`);--> statement-breakpoint
CREATE TABLE `disposals` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`customer_id` text NOT NULL,
	`disposed_on` text NOT NULL,
	`contact_name` text,
	`memo` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `disposals_customer` ON `disposals` (`customer_id`,`disposed_on`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`transaction_date` text NOT NULL,
	`description` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_name` text,
	`unit_price_centi` integer NOT NULL,
	`amount` integer NOT NULL,
	`tax_category` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice` ON `invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`customer_id` text NOT NULL,
	`issued_on` text NOT NULL,
	`period_from` text,
	`period_to` text,
	`due_on` text,
	`subtotal` integer NOT NULL,
	`tax` integer NOT NULL,
	`total` integer NOT NULL,
	`tax_summary` text NOT NULL,
	`rounding_mode` text NOT NULL,
	`recipient_snapshot` text NOT NULL,
	`issuer_snapshot` text NOT NULL,
	`allocated` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`pdf_key` text,
	`reissued_from_id` text,
	`cancel_reason` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number` ON `invoices` (`number`);--> statement-breakpoint
CREATE INDEX `invoices_customer` ON `invoices` (`customer_id`,`issued_on`);--> statement-breakpoint
CREATE INDEX `invoices_status_due` ON `invoices` (`status`,`due_on`);--> statement-breakpoint
CREATE TABLE `payment_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`invoice_id` text NOT NULL,
	`amount` integer NOT NULL,
	`adjustment` integer DEFAULT 0 NOT NULL,
	`adjustment_kind` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payment_allocations_payment` ON `payment_allocations` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_allocations_invoice` ON `payment_allocations` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `sales_charges` (
	`id` text PRIMARY KEY NOT NULL,
	`sales_order_id` text NOT NULL,
	`description` text DEFAULT '送料' NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_amount` integer NOT NULL,
	`tax_category` text DEFAULT 'standard' NOT NULL,
	`memo` text
);
--> statement-breakpoint
CREATE INDEX `sales_charges_order` ON `sales_charges` (`sales_order_id`);--> statement-breakpoint
CREATE TABLE `sales_order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`sales_order_id` text NOT NULL,
	`line_no` integer NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`unit_price_centi` integer NOT NULL,
	`price_override_reason` text,
	`tax_category` text NOT NULL,
	`memo` text
);
--> statement-breakpoint
CREATE INDEX `sales_order_lines_order` ON `sales_order_lines` (`sales_order_id`);--> statement-breakpoint
CREATE INDEX `sales_order_lines_item` ON `sales_order_lines` (`item_id`);--> statement-breakpoint
CREATE TABLE `sales_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text NOT NULL,
	`ordered_on` text NOT NULL,
	`customer_contact_name` text,
	`maker_direct` integer DEFAULT false NOT NULL,
	`location_id` text,
	`employee_id` text,
	`delivery_requested_on` text,
	`ship_planned_on` text NOT NULL,
	`split_from_id` text,
	`memo` text,
	`cancel_reason` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_orders_number` ON `sales_orders` (`number`);--> statement-breakpoint
CREATE INDEX `sales_orders_status_ship` ON `sales_orders` (`status`,`ship_planned_on`);--> statement-breakpoint
CREATE INDEX `sales_orders_customer` ON `sales_orders` (`customer_id`);--> statement-breakpoint
CREATE TABLE `sales_return_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`sales_return_id` text NOT NULL,
	`sales_order_line_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`restock` integer NOT NULL,
	`location_id` text,
	`unit_price_centi` integer NOT NULL,
	`amount` integer NOT NULL,
	`tax_category` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sales_return_lines_return` ON `sales_return_lines` (`sales_return_id`);--> statement-breakpoint
CREATE TABLE `sales_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`sales_order_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`returned_on` text NOT NULL,
	`invoice_id` text,
	`credit_note_number` text,
	`credit_note_pdf_key` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`memo` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sales_returns_order` ON `sales_returns` (`sales_order_id`);--> statement-breakpoint
CREATE INDEX `sales_returns_customer` ON `sales_returns` (`customer_id`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`sales_order_id` text NOT NULL,
	`delivery_note_number` text NOT NULL,
	`shipped_on` text NOT NULL,
	`invoice_id` text,
	`cancelled` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `shipments_order` ON `shipments` (`sales_order_id`);--> statement-breakpoint
CREATE INDEX `shipments_invoice` ON `shipments` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `shipments_date` ON `shipments` (`shipped_on`);--> statement-breakpoint
CREATE TABLE `stock_balances` (
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`on_hand` integer DEFAULT 0 NOT NULL,
	`allocated` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`item_id`, `location_id`)
);
--> statement-breakpoint
CREATE INDEX `stock_balances_location` ON `stock_balances` (`location_id`);--> statement-breakpoint
CREATE TABLE `stock_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`business_date` text NOT NULL,
	`item_id` text NOT NULL,
	`location_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`reason` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`reverses_id` text,
	`memo` text,
	`created_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_ledger_item` ON `stock_ledger` (`item_id`,`business_date`);--> statement-breakpoint
CREATE INDEX `stock_ledger_source` ON `stock_ledger` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `stock_operation_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`item_id` text NOT NULL,
	`quantity` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_operation_lines_op` ON `stock_operation_lines` (`operation_id`);--> statement-breakpoint
CREATE TABLE `stock_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`kind` text NOT NULL,
	`operation_date` text NOT NULL,
	`location_id` text NOT NULL,
	`to_location_id` text,
	`store_id` text,
	`adjustment_reason` text,
	`memo` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_operations_date` ON `stock_operations` (`operation_date`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text NOT NULL,
	`employee_id` text NOT NULL,
	`command` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text
);
--> statement-breakpoint
CREATE INDEX `audit_logs_entity` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_occurred` ON `audit_logs` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `document_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`method` text NOT NULL,
	`recipient` text,
	`status` text NOT NULL,
	`error` text,
	`sent_at` text,
	`note` text,
	`job_id` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `document_sends_document` ON `document_sends` (`document_id`);--> statement-breakpoint
CREATE INDEX `document_sends_status` ON `document_sends` (`status`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`document_type` text NOT NULL,
	`number` text NOT NULL,
	`entity_id` text NOT NULL,
	`partner_id` text NOT NULL,
	`transaction_date` text NOT NULL,
	`amount` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	`r2_key` text,
	`status` text NOT NULL,
	`cancelled` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `documents_search` ON `documents` (`transaction_date`,`partner_id`);--> statement-breakpoint
CREATE INDEX `documents_entity` ON `documents` (`document_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`command` text NOT NULL,
	`employee_id` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`result_key` text,
	`result_name` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`finished_at` text,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_status` ON `jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `sequences` (
	`key` text PRIMARY KEY NOT NULL,
	`next_value` integer NOT NULL
);
