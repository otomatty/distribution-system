/**
 * 請求・入金の結合テストのデータ（発送済みの受注・締め日のある販売先・請求書・入金）をシステムの操作者で作る。
 * 日付は今日から決める（締め期間を過ぎた発送は、前の月の日付で発送する）。
 */
import { addDays, addMonths, monthOf, monthRange } from "../../src/domain/dates";
import type { CommandInput } from "../../src/usecases/registry";
import { systemCommand, systemQuery } from "./helpers";
import { createCustomer, createOrder, getOrder, salesSetup, today } from "./sales-fixtures";

/** 前の月の初日・末日（月末締めの販売先なら、締め日を過ぎた締め期間） */
export function lastMonth(): { from: string; to: string } {
  return monthRange(addMonths(monthOf(today()), -1));
}

export async function setTerms(
  customerId: string,
  terms: { closingDay: number; paymentMonthOffset: number; paymentDay: number } = {
    closingDay: 31,
    paymentMonthOffset: 1,
    paymentDay: 31,
  },
): Promise<void> {
  const partner = await systemQuery("partners.get", { id: customerId });
  if (!partner) throw new Error("partner not found");
  await systemCommand("partners.updateTerms", {
    id: customerId,
    version: partner.version,
    terms,
  });
}

type Setup = Awaited<ReturnType<typeof salesSetup>>;

/** 受注を作って発送する（明細：a を3個、b を6個、送料800円） */
export async function shipOrder(
  setup: Setup,
  options: {
    customerId?: string;
    shippedOn?: string;
    lines?: CommandInput<"salesOrders.create">["lines"];
    charges?: CommandInput<"salesOrders.create">["charges"];
  } = {},
) {
  const order = await createOrder({
    customerId: options.customerId ?? setup.customer.id,
    locationId: setup.locationId,
    orderedOn: options.shippedOn ?? today(),
    shipPlannedOn: options.shippedOn ?? today(),
    lines: options.lines ?? [
      { itemId: setup.a.id, quantity: 3, unitPriceCenti: 15_050 },
      { itemId: setup.b.id, quantity: 6, unitPriceCenti: 10_000 },
    ],
    charges: options.charges ?? [{ description: "送料", quantity: 1, unitAmount: 800 }],
  });
  const view = await getOrder(order.id);
  const shipped = await systemCommand("shipments.ship", {
    id: order.id,
    version: view.order.version,
    shippedOn: options.shippedOn ?? today(),
  });
  const shipment = (await getOrder(order.id)).shipments[0];
  if (!shipment) throw new Error("shipment not found");
  return { order, shipmentId: shipped.shipmentId, shipmentVersion: shipment.version };
}

/** 在庫を多めに入れた販売の準備（a・b とも50個） */
export async function billingSetup() {
  return salesSetup({ a: 50, b: 60 });
}

/** 締め日のない販売先の発送を、発送ごとの請求書にする（返品伝票は載せない） */
export async function issuePerShipment(
  shipment: { shipmentId: string; shipmentVersion: number },
  options: { issuedOn?: string; dueOn?: string; returns?: { id: string; version: number }[] } = {},
) {
  return systemCommand("invoices.issue", {
    shipmentId: shipment.shipmentId,
    version: shipment.shipmentVersion,
    returns: options.returns ?? [],
    issuedOn: options.issuedOn ?? today(),
    dueOn: options.dueOn ?? addDays(today(), 30),
  });
}

export async function invoiceView(id: string) {
  const view = await systemQuery("invoices.get", { id });
  if (!view) throw new Error(`invoice ${id} not found`);
  return view;
}

export async function createClosingCustomer() {
  const customer = await createCustomer();
  await setTerms(customer.id);
  return customer;
}

/** 返品伝票を記録する（明細の最初の行を quantity 個、在庫に戻すなら保管場所へ） */
export async function recordReturn(
  orderId: string,
  options: { quantity?: number; restockTo?: string | null; returnedOn?: string } = {},
) {
  const order = await getOrder(orderId);
  const line = order.order.lines[0];
  if (!line) throw new Error("no lines");
  const locationId = options.restockTo ?? null;
  return systemCommand("salesReturns.create", {
    salesOrderId: orderId,
    returnedOn: options.returnedOn ?? today(),
    lines: [
      {
        salesOrderLineId: line.id,
        quantity: options.quantity ?? 1,
        restock: locationId !== null,
        locationId,
      },
    ],
  });
}

export async function returnVersion(id: string): Promise<number> {
  const view = await systemQuery("salesReturns.get", { id });
  if (!view) throw new Error("return not found");
  return view.ret.version;
}
