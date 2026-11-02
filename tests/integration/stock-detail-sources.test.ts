/**
 * 在庫明細（/stock/:itemId）の発生元の欄（要件定義書 3.4）。入荷・仕入返品・発送・在庫操作のどの行にも、
 * 発生元の伝票の番号とその画面へのリンクを出す（返品伝票は受注の画面）。
 */
import { describe, expect, it } from "vitest";

import { addInitialStock, createItem, createLocation, createSupplier } from "./fixtures";
import { as, createEmployee, systemCommand, systemQuery } from "./helpers";
import { createConfirmedOrder, orderView, receive } from "./purchasing-fixtures";
import { createCustomer, createOrder, getOrder, today } from "./sales-fixtures";

describe("在庫明細の発生元", () => {
  it("入荷 RC-・仕入返品 PR-・発送 DN-・返品伝票 RT-・在庫操作 SOP- の番号と、発注・受注・在庫操作の画面へのリンクを出す", async () => {
    const supplierId = await createSupplier();
    const locationId = await createLocation();
    const item = await createItem(supplierId);
    const operationId = await addInitialStock(locationId, [{ itemId: item.id, quantity: 5 }]);
    const operation = await systemQuery("stockOperations.get", { id: operationId });

    const po = await createConfirmedOrder({
      supplierId,
      locationId,
      lines: [{ itemId: item.id, quantity: 2 }],
    });
    const receipt = await receive(po.id, [2], { receivedOn: "2026-10-10" });
    const purchaseReturn = await systemCommand("purchaseReturns.create", {
      purchaseOrderId: po.id,
      returnedOn: "2026-10-11",
      locationId,
      memo: "破損",
      lines: [{ lineId: (await orderView(po.id)).order.lines[0]?.id ?? "", units: 1 }],
    });

    const customer = await createCustomer();
    const so = await createOrder({
      customerId: customer.id,
      locationId,
      lines: [{ itemId: item.id, quantity: 3, unitPriceCenti: 15_050 }],
    });
    const shipped = await systemCommand("shipments.ship", {
      id: so.id,
      version: (await getOrder(so.id)).order.version,
      shippedOn: today(),
    });

    const soLine = (await getOrder(so.id)).order.lines[0]?.id ?? "";
    const salesReturn = await systemCommand("salesReturns.create", {
      salesOrderId: so.id,
      returnedOn: today(),
      memo: "",
      lines: [{ salesOrderLineId: soLine, quantity: 1, restock: true, locationId }],
    });

    const user = await createEmployee(["purchasing"]);
    const html = await (await as(user).get(`/stock/${item.id}?from=2026-01-01`)).text();
    const receiptView = (await orderView(po.id)).receipts[0];
    expect(receiptView?.id).toBe(receipt.id);
    expect(html).toContain(`<a href="/purchase-orders/${po.id}">入荷 ${receiptView?.number}</a>`);
    expect(html).toContain(
      `<a href="/purchase-orders/${po.id}">仕入返品 ${purchaseReturn.number}</a>`,
    );
    expect(html).toContain(
      `<a href="/sales-orders/${so.id}">発送 ${shipped.deliveryNoteNumber}</a>`,
    );
    expect(html).toContain(
      `<a href="/stock/operations/${operationId}">在庫操作 ${operation?.number}</a>`,
    );
    expect(html).toContain(`<a href="/sales-orders/${so.id}">返品伝票 ${salesReturn.number}</a>`);
  });
});
