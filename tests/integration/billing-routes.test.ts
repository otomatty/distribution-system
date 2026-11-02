/**
 * 請求・入金・返品・販売先廃棄の画面のルート（要件定義書 5章）。
 * 一覧の絞り込みと CSV、発行・締め処理・取消と再発行、返品伝票と返還請求書、入金と消込、売掛残高、廃棄伝票と廃棄率。
 */
import { describe, expect, it } from "vitest";

import { addDays } from "../../src/domain/dates";
import {
  billingSetup,
  createClosingCustomer,
  invoiceView,
  issuePerShipment,
  lastMonth,
  recordReturn,
  returnVersion,
  shipOrder,
} from "./billing-fixtures";
import { as, createEmployee, newKey, systemQuery } from "./helpers";
import { documentRow, pendingJobIds, runJobs } from "./platform-helpers";
import { getOrder, today } from "./sales-fixtures";

function csvRows(text: string): string[] {
  return text.replace("﻿", "").trim().split("\r\n");
}

describe("請求書の画面", () => {
  it("未請求の発送から発送ごとの請求書を発行し、詳細・PDF・一覧・CSV に出る", async () => {
    const user = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { restockTo: null });

    const unbilled = await (
      await as(user).get(`/invoices/new?customerId=${setup.customer.id}`)
    ).text();
    expect(unbilled).toContain("未請求の発送");
    expect(unbilled).toContain(`/invoices/new?shipmentId=${shipped.shipmentId}`);
    expect(unbilled).toContain("¥2,027");

    const form = await (
      await as(user).get(`/invoices/new?shipmentId=${shipped.shipmentId}`)
    ).text();
    expect(form).toContain("請求書の発行（発送ごと）");
    expect(form).toContain(ret.number);
    expect(form).toContain("¥1,865");
    // 返品を外すと見積もりだけを差し替える
    const preview = await (
      await as(user).hx("/invoices/new/preview", {
        shipmentId: shipped.shipmentId,
        returnsShown: "1",
      })
    ).text();
    expect(preview).toContain('id="invoice-preview"');
    expect(preview).toContain("¥2,027");

    const res = await as(user).hx("/invoices/new", {
      _key: newKey(),
      shipmentId: shipped.shipmentId,
      version: String(shipped.shipmentVersion),
      returnRef: `${ret.id}:${await returnVersion(ret.id)}`,
      issuedOn: today(),
      dueOn: addDays(today(), 30),
    });
    const location = res.headers.get("HX-Redirect") ?? "";
    expect(location).toMatch(/^\/invoices\/[0-9A-Z]{26}\?notice=issued$/);
    const id = location.split("/")[2]!.split("?")[0]!;
    const detail = await (await as(user).get(location)).text();
    expect(detail).toContain("請求書を発行しました");
    expect(detail).toContain("未入金");
    expect(detail).toContain("¥1,865");
    expect(detail).toContain("請求書を取り消す");
    expect(detail).toContain("入金を記録して消し込む");

    // PDF（テストでは HTML）を作ると、請求書のテンプレートで描ける
    const view = await invoiceView(id);
    await runJobs(await pendingJobIds("render_document"));
    expect((await documentRow(view.document!.documentId))?.status).toBe("ready");
    const file = await (
      await as(user).get(`/documents/${view.document!.documentId}/download`)
    ).text();
    expect(file).toContain("請求書");
    expect(file).toContain(view.invoice.number);
    expect(file).toContain("ご請求金額（税込） ¥1,865");

    const list = await (await as(user).get(`/invoices?customerId=${setup.customer.id}`)).text();
    expect(list).toContain(view.invoice.number);
    const partial = await (
      await as(user).get(`/invoices?customerId=${setup.customer.id}&status=paid`, {
        "HX-Request": "true",
      })
    ).text();
    expect(partial).toContain("条件に合う請求書はありません");
    const csv = await as(user).post("/invoices/csv", {
      _key: newKey(),
      customerId: setup.customer.id,
    });
    expect(csv.headers.get("Content-Type")).toContain("text/csv");
    const rows = csvRows(await csv.text());
    expect(rows[0]).toContain("請求書番号,状態");
    expect(rows[1]).toContain(`${view.invoice.number},未入金`);

    // 受注詳細から請求書へ移れる
    const order = await (await as(user).get(`/sales-orders/${shipped.order.id}`)).text();
    expect(order).toContain(`/invoices/${id}`);
    expect(order).toContain("返品伝票");
  });

  it("発行のエラーは項目の横に出す。締め日のある販売先は締め処理へ案内する。権限がなければ発行できない", async () => {
    const user = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const shipped = await shipOrder(setup, { shippedOn: addDays(today(), -2) });
    const res = await as(user).hx("/invoices/new", {
      _key: newKey(),
      shipmentId: shipped.shipmentId,
      version: String(shipped.shipmentVersion),
      issuedOn: addDays(today(), -5),
    });
    const html = await res.text();
    expect(html).toContain('id="issue-form"');
    expect(html).toContain("発行日は最後の取引日");

    const sales = await createEmployee(["sales"]);
    const page = await (
      await as(sales).get(`/invoices/new?shipmentId=${shipped.shipmentId}`)
    ).text();
    expect(page).toContain("請求書を発行する権限がありません");
    const forbidden = await as(sales).post("/invoices/new", {
      _key: newKey(),
      shipmentId: shipped.shipmentId,
      version: String(shipped.shipmentVersion),
      issuedOn: today(),
    });
    expect(await forbidden.text()).toContain("権限がありません");

    const customer = await createClosingCustomer();
    const closingShip = await shipOrder(setup, { customerId: customer.id });
    const closing = await (
      await as(user).get(`/invoices/new?shipmentId=${closingShip.shipmentId}`)
    ).text();
    expect(closing).toContain("締め日のある販売先です");
    expect(await (await as(user).get("/invoices/new?shipmentId=missing")).text()).toContain(
      "すでに請求書に載っているか",
    );
  });

  it("締め処理：確認で対象と件数を示し、一括発行して一括 PDF に進める", async () => {
    const user = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const period = lastMonth();
    const customer = await createClosingCustomer();
    await shipOrder(setup, { customerId: customer.id, shippedOn: period.from });
    const page = await (await as(user).get(`/invoices/closing?customerId=${customer.id}`)).text();
    expect(page).toContain(customer.name);
    expect(page).toContain(`${period.from}〜${period.to}`);
    expect(page).toContain("締め処理待ち");

    const confirm = await (
      await as(user).hx("/invoices/closing/confirm", { customerId: customer.id, issuedOn: "" })
    ).text();
    expect(confirm).toContain("締め処理の確認");
    expect(confirm).toContain("1 件の請求書を発行する");
    const fields = [...confirm.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)];
    const form: Record<string, string[]> = {};
    for (const [, name, value] of fields) (form[name!] ??= []).push(value!);
    const run = await (await as(user).hx("/invoices/closing/run", form)).text();
    expect(run).toContain("1 件の請求書を発行しました");
    expect(run).toContain("発行した 1 件の請求書を一括で PDF にする");
    const issued = await systemQuery("invoices.list", { customerId: customer.id });
    expect(issued.rows[0]).toMatchObject({ issuedOn: period.to, periodTo: period.to });

    // 同じ受付番号でもう一度送っても、発行は1回だけ
    expect(await (await as(user).hx("/invoices/closing/run", form)).text()).toContain(
      "発行しました",
    );
    expect((await systemQuery("invoices.list", { customerId: customer.id })).total).toBe(1);

    const bulk = await as(user).post("/invoices/bulk-pdf", {
      _key: newKey(),
      name: "請求書_テスト",
      invoiceId: issued.rows.map((r) => r.id),
    });
    expect(bulk.status).toBe(303);
    expect(bulk.headers.get("Location")).toBe("/jobs?notice=bulk");

    // 何も選ばずに確認すると、発行できる販売先がないと示す
    expect(await (await as(user).hx("/invoices/closing/confirm", {})).text()).toContain(
      "発行できる販売先が選ばれていません",
    );
  });

  it("取消と再発行（詳細の部分だけを差し替える）", async () => {
    const user = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const first = await issuePerShipment(await shipOrder(setup));
    const v = (await invoiceView(first.id)).invoice.version;
    const empty = await (
      await as(user).hx(`/invoices/${first.id}/cancel`, {
        _key: newKey(),
        version: String(v),
        reason: "",
      })
    ).text();
    expect(empty).toContain('id="invoice-detail"');
    expect(empty).toContain("理由：");
    const cancelled = await (
      await as(user).hx(`/invoices/${first.id}/cancel`, {
        _key: newKey(),
        version: String(v),
        reason: "宛名の誤り",
      })
    ).text();
    expect(cancelled).toContain("請求書を取り消しました");
    expect(cancelled).toContain("取消済み");

    const second = await issuePerShipment(await shipOrder(setup));
    const v2 = (await invoiceView(second.id)).invoice.version;
    const reissued = await as(user).hx(`/invoices/${second.id}/reissue`, {
      _key: newKey(),
      version: String(v2),
      reason: "住所の変更",
      issuedOn: today(),
      dueOn: addDays(today(), 10),
    });
    const location = reissued.headers.get("HX-Redirect") ?? "";
    expect(location).toMatch(/notice=reissued$/);
    const html = await (await as(user).get(location)).text();
    expect(html).toContain("再発行の元");
    expect(html).toContain(second.number);
    // 古い版番号では取り消せない（エラーを詳細に出す）
    const stale = await as(user).post(`/invoices/${second.id}/cancel`, {
      _key: newKey(),
      version: String(v2),
      reason: "もう一度",
    });
    expect(stale.status).toBe(409);
  });
});

describe("返品伝票の画面", () => {
  it("受注詳細から返品伝票を登録し、返還請求書を発行し、取り消せない理由を示す", async () => {
    const sales = await createEmployee(["sales"]);
    const accounting = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const order = await (await as(sales).get(`/sales-orders/${shipped.order.id}`)).text();
    expect(order).toContain(`/sales-returns/new?orderId=${shipped.order.id}`);

    const form = await (
      await as(sales).get(`/sales-returns/new?orderId=${shipped.order.id}`)
    ).text();
    expect(form).toContain("返品伝票の登録");
    expect(form).toContain(setup.a.name);
    const lines = (await getOrder(shipped.order.id)).order.lines;
    const post = (quantities: string[]) =>
      as(sales).hx(`/sales-returns/new?orderId=${shipped.order.id}`, {
        _key: newKey(),
        returnedOn: today(),
        memo: "",
        lineId: lines.map((l) => l.id),
        lineQuantity: quantities,
        lineHandling: ["restock", "dispose"],
        lineLocationId: [setup.locationId, ""],
      });
    const tooMany = await (await post(["9", ""])).text();
    expect(tooMany).toContain('id="return-form"');
    expect(tooMany).toContain("返品できる数（残り3）を超えています");
    const ok = await post(["1", "2"]);
    const location = ok.headers.get("HX-Redirect") ?? "";
    expect(location).toMatch(/^\/sales-returns\/[0-9A-Z]{26}\?notice=created$/);
    const returnId = location.split("/")[2]!.split("?")[0]!;
    const detail = await (await as(sales).get(location)).text();
    expect(detail).toContain("返品伝票を登録しました");
    expect(detail).toContain("在庫に戻した");
    expect(detail).toContain("廃棄");
    expect(detail).toContain("返品伝票を取り消す");
    // 未請求の返品は、請求書で差し引けない返品として返還請求書を発行できる（受注・出荷担当には発行の操作を出さない）
    expect(detail).toContain("この返品はどの請求書にも載っていません");
    expect(detail).toContain("返還請求書を発行する権限がありません");

    const ret = await systemQuery("salesReturns.get", { id: returnId });
    await issuePerShipment(shipped, { returns: [{ id: returnId, version: ret!.ret.version }] });
    const invoiced = await (await as(accounting).get(`/sales-returns/${returnId}`)).text();
    expect(invoiced).toContain("税込1万円未満の返品なので、返還請求書の交付は任意です");
    expect(invoiced).toContain("返還請求書を発行する");
    expect(invoiced).toContain("請求書に載せた返品伝票は取り消せません");
    const v = (await systemQuery("salesReturns.get", { id: returnId }))!.ret.version;
    const issued = await (
      await as(accounting).hx(`/sales-returns/${returnId}/credit-note`, {
        _key: newKey(),
        version: String(v),
        issuedOn: today(),
      })
    ).text();
    expect(issued).toContain("返還請求書を発行しました");
    expect(issued).toMatch(/CN-\d{4}-\d{6}/);
    // 受注・出荷担当は返還請求書を発行するボタンを見ない
    const other = await billingSetup();
    const s2 = await shipOrder(other);
    const r2 = await recordReturn(s2.order.id, { restockTo: null });
    await issuePerShipment(s2, { returns: [{ id: r2.id, version: await returnVersion(r2.id) }] });
    const salesView = await (await as(sales).get(`/sales-returns/${r2.id}`)).text();
    expect(salesView).toContain("返還請求書を発行する権限がありません");
  });

  it("未請求の返品伝票を取り消すと、在庫を打ち消しで戻す", async () => {
    const sales = await createEmployee(["sales"]);
    const setup = await billingSetup();
    const shipped = await shipOrder(setup);
    const ret = await recordReturn(shipped.order.id, { quantity: 2, restockTo: setup.locationId });
    const v = await returnVersion(ret.id);
    const html = await (
      await as(sales).hx(`/sales-returns/${ret.id}/cancel`, {
        _key: newKey(),
        version: String(v),
        reason: "返品数の数え間違い",
      })
    ).text();
    expect(html).toContain("返品伝票を取り消しました");
    // 取消の理由を返品伝票と、受注詳細の返品伝票の一覧に出す
    expect(html).toContain("返品数の数え間違い");
    const detail = await (await as(sales).get(`/sales-returns/${ret.id}`)).text();
    expect(detail).toContain("取消の理由");
    expect(detail).toContain("返品数の数え間違い");
    const order = await (await as(sales).get(`/sales-orders/${shipped.order.id}`)).text();
    expect(order).toContain("取消の理由：返品数の数え間違い");
    const notFound = await as(sales).get("/sales-returns/new?orderId=missing");
    expect(notFound.status).toBe(404);
  });
});

describe("入金の画面", () => {
  it("販売先を選ぶと消し込める請求書を出し、入金と消込を記録し、詳細で取り消せる", async () => {
    const user = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const invoice = await issuePerShipment(await shipOrder(setup));
    const v = (await invoiceView(invoice.id)).invoice.version;
    const page = await (await as(user).get("/receipts/new")).text();
    expect(page).toContain("販売先を選ぶと、消し込める請求書を表示します");
    const table = await (
      await as(user).get(`/receipts/new/invoices?customerId=${setup.customer.id}`)
    ).text();
    expect(table).toContain(invoice.number);
    expect(table).toContain(`${invoice.id}:${v}`);

    const bad = await (
      await as(user).hx("/receipts/new", {
        _key: newKey(),
        customerId: setup.customer.id,
        receivedOn: today(),
        amount: "3000",
        method: "transfer",
        allocInvoice: `${invoice.id}:${v}`,
        allocAmount: "2000",
        allocAdjustment: "27",
        allocKind: "",
      })
    ).text();
    expect(bad).toContain('id="receipt-form"');
    expect(bad).toContain("差額の区分");

    const res = await as(user).hx("/receipts/new", {
      _key: newKey(),
      customerId: setup.customer.id,
      receivedOn: today(),
      amount: "3000",
      method: "transfer",
      memo: "振込",
      allocInvoice: `${invoice.id}:${v}`,
      allocAmount: "2000",
      allocAdjustment: "27",
      allocKind: "bank_fee",
    });
    const location = res.headers.get("HX-Redirect") ?? "";
    expect(location).toMatch(/^\/receipts\/[0-9A-Z]{26}\?notice=created$/);
    const paymentId = location.split("/")[2]!.split("?")[0]!;
    const detail = await (await as(user).get(location)).text();
    expect(detail).toContain("入金を記録しました");
    expect(detail).toContain("振込手数料");
    expect(detail).toContain("¥1,000");
    expect((await invoiceView(invoice.id)).invoice.status).toBe("paid");

    // 残りを別の請求書に消し込む
    const second = await issuePerShipment(await shipOrder(setup));
    const payment = await systemQuery("customerPayments.get", { id: paymentId });
    const v2 = (await invoiceView(second.id)).invoice.version;
    const allocated = await (
      await as(user).hx(`/receipts/${paymentId}/allocate`, {
        _key: newKey(),
        version: String(payment!.payment.version),
        allocInvoice: `${second.id}:${v2}`,
        allocAmount: "1000",
        allocAdjustment: "",
        allocKind: "",
      })
    ).text();
    expect(allocated).toContain("請求書に消し込みました");
    expect((await invoiceView(second.id)).invoice.status).toBe("partial");

    const allocation = (await systemQuery("customerPayments.get", { id: paymentId }))!
      .allocations[0]!;
    // 消込の取消は理由が必須。理由がなければ入金の画面に理由を出す（取り消さない）
    const noReason = await (
      await as(user).hx(`/receipts/allocations/${allocation.id}/cancel`, {
        _key: newKey(),
        version: String(allocation.version),
        paymentId,
        reason: "",
      })
    ).text();
    expect(noReason).toContain('id="receipt-detail"');
    expect(noReason).toContain("消込の取消の理由を入力してください");
    expect((await invoiceView(second.id)).invoice.status).toBe("partial");
    const released = await (
      await as(user).hx(`/receipts/allocations/${allocation.id}/cancel`, {
        _key: newKey(),
        version: String(allocation.version),
        paymentId,
        reason: "請求書を取り違えた",
      })
    ).text();
    expect(released).toContain("消込を取り消しました");
    expect(released).toContain("取消の理由：請求書を取り違えた");
    expect((await invoiceView(second.id)).invoice.status).toBe("unpaid");
    const invoicePage = await (await as(user).get(`/invoices/${second.id}`)).text();
    expect(invoicePage).toContain("取消の理由：請求書を取り違えた");

    const current = (await systemQuery("customerPayments.get", { id: paymentId }))!.payment;
    const cancelled = await (
      await as(user).hx(`/receipts/${paymentId}/cancel`, {
        _key: newKey(),
        version: String(current.version),
        reason: "二重記録",
      })
    ).text();
    expect(cancelled).toContain("入金を取り消しました");
    expect((await invoiceView(invoice.id)).invoice.status).toBe("unpaid");
    // 取消の理由を入金の画面（/receipts/:id）と、一覧・CSV に出す
    const receiptPage = await (await as(user).get(`/receipts/${paymentId}`)).text();
    expect(receiptPage).toContain("取消の理由");
    expect(receiptPage).toContain("二重記録");
    expect(receiptPage).toContain("取消の理由：入金の取消：二重記録");

    const list = await (
      await as(user).get(`/receipts?customerId=${setup.customer.id}&includeCancelled=1`)
    ).text();
    expect(list).toContain("取消");
    expect(list).toContain("取消の理由：二重記録");
    const csv = await as(user).post("/receipts/csv", {
      _key: newKey(),
      customerId: setup.customer.id,
      includeCancelled: "1",
    });
    const rows = csvRows(await csv.text());
    expect(rows[0]).toContain("取消の理由");
    expect(rows[1]).toContain("振込,3000");
    expect(rows[1]).toContain("二重記録");

    const sales = await createEmployee(["sales"]);
    expect(await (await as(sales).get("/receipts/new")).text()).toContain(
      "入金を記録する権限がありません",
    );
    const missing = await as(user).post(`/receipts/allocations/missing/cancel`, {
      _key: newKey(),
      version: "1",
      reason: "x",
    });
    expect(missing.status).toBe(409);
  });
});

describe("売掛残高・入金予定の画面", () => {
  it("販売先ごとの残高と、支払期限の順の入金予定（期限超過を強調）と CSV", async () => {
    const user = await createEmployee(["accounting"]);
    const setup = await billingSetup();
    const overdue = await issuePerShipment(
      await shipOrder(setup, { shippedOn: addDays(today(), -20) }),
      {
        issuedOn: addDays(today(), -20),
        dueOn: addDays(today(), -1),
      },
    );
    const balances = await (
      await as(user).get(`/receivables?customerId=${setup.customer.id}`)
    ).text();
    expect(balances).toContain(setup.customer.name);
    expect(balances).toContain("row-danger");
    expect(balances).toContain("¥2,027");
    const schedule = await (
      await as(user).get(`/receivables/schedule?customerId=${setup.customer.id}`)
    ).text();
    expect(schedule).toContain(overdue.number);
    expect(schedule).toContain("期限超過");
    const csv1 = await as(user).post("/receivables/csv", {
      _key: newKey(),
      customerId: setup.customer.id,
    });
    expect(csvRows(await csv1.text())[1]).toContain(`${setup.customer.name},2027,2027,0,2027`);
    const csv2 = await as(user).post("/receivables/schedule/csv", {
      _key: newKey(),
      customerId: setup.customer.id,
      overdue: "1",
    });
    expect(csvRows(await csv2.text())[1]).toContain(
      `${addDays(today(), -1)},超過,${overdue.number}`,
    );

    // ダッシュボード（経理）に請求・入金の欄が出る
    const dashboard = await (await as(user).get("/")).text();
    expect(dashboard).toContain("請求・入金");
    expect(dashboard).toContain("支払期限を過ぎた請求書");
    expect(dashboard).toContain("締め処理待ちの販売先");
    const sales = await createEmployee(["sales"]);
    expect(await (await as(sales).get("/")).text()).not.toContain("締め処理待ちの販売先");
  });
});

describe("販売先廃棄の画面", () => {
  it("販売先を選ぶと出荷した商品を並べ、廃棄伝票を登録し、廃棄率を集計する", async () => {
    const user = await createEmployee(["sales"]);
    const setup = await billingSetup();
    await shipOrder(setup);
    const page = await (await as(user).get("/disposals/new")).text();
    expect(page).toContain("廃棄伝票の登録");
    const shipped = await (
      await as(user).hx("/disposals/new/shipped", { customerId: setup.customer.id })
    ).text();
    expect(shipped).toContain('id="disposal-lines"');
    expect(shipped).toContain(setup.a.name);
    expect(shipped).toContain("最後の出荷");
    const added = await (
      await as(user).hx("/disposals/new/lines", {
        itemIds: [setup.a.id, setup.b.id],
        lineItemId: setup.a.id,
      })
    ).text();
    expect(added).toContain(setup.b.name);
    expect(added).not.toContain(setup.a.name);
    expect(
      (await as(user).hx("/disposals/new/lines", { itemIds: setup.a.id, lineItemId: setup.a.id }))
        .status,
    ).toBe(200);

    const base = {
      _key: newKey(),
      customerId: setup.customer.id,
      disposedOn: today(),
      contactName: "店長",
      memo: "",
      lineItemId: [setup.a.id, setup.b.id],
      lineCode: [setup.a.code, setup.b.code],
      lineName: [setup.a.name, setup.b.name],
      lineUnit: ["個", "個"],
      lineShipped: [today(), today()],
      lineReason: ["expired", ""],
    };
    const invalid = await (
      await as(user).hx("/disposals/new", { ...base, lineQuantity: ["0", ""] })
    ).text();
    expect(invalid).toContain('id="disposal-form"');
    expect(invalid).toContain("数量は1以上");
    const res = await as(user).hx("/disposals/new", {
      ...base,
      _key: newKey(),
      lineQuantity: ["2", ""],
    });
    const location = res.headers.get("HX-Redirect") ?? "";
    expect(location).toMatch(/^\/disposals\/[0-9A-Z]{26}\?notice=created$/);
    const detail = await (await as(user).get(location)).text();
    expect(detail).toContain("廃棄伝票を登録しました");
    expect(detail).toContain("賞味期限切れ");

    const list = await (await as(user).get(`/disposals?customerId=${setup.customer.id}`)).text();
    expect(list).toMatch(/DS-\d{4}-\d{6}/);
    const rates = await (
      await as(user).get(
        `/disposals/rates?customerId=${setup.customer.id}&from=${addDays(today(), -7)}&to=${today()}`,
      )
    ).text();
    expect(rates).toContain(setup.a.name);
    expect(rates).toContain("66.67%");
    const byCustomer = await (
      await as(user).get(`/disposals/rates?customerId=${setup.customer.id}&groupBy=customer&all=1`)
    ).text();
    expect(byCustomer).toContain(setup.customer.name);
    const csv = await as(user).post("/disposals/rates/csv", {
      _key: newKey(),
      customerId: setup.customer.id,
      from: addDays(today(), -7),
      to: today(),
    });
    expect(csvRows(await csv.text())[1]).toContain(`${setup.a.code},${setup.a.name},2,3,66.67%`);
    const listCsv = await as(user).post("/disposals/csv", {
      _key: newKey(),
      customerId: setup.customer.id,
    });
    expect(csvRows(await listCsv.text())).toHaveLength(2);

    const accounting = await createEmployee(["accounting"]);
    expect(await (await as(accounting).get("/disposals/new")).text()).toContain(
      "廃棄伝票を登録する権限がありません",
    );
    expect((await as(accounting).get("/disposals/missing")).status).toBe(404);
  });
});

describe("請求の画面の権限", () => {
  it("閲覧は全員ができ、操作のボタンは権限のある人にだけ出す", async () => {
    const purchasing = await createEmployee(["purchasing"]);
    const setup = await billingSetup();
    const invoice = await issuePerShipment(await shipOrder(setup));
    const html = await (await as(purchasing).get(`/invoices/${invoice.id}`)).text();
    expect(html).toContain(invoice.number);
    expect(html).not.toContain("請求書を取り消す");
    expect(html).not.toContain("入金を記録して消し込む");
    const forbidden = await as(purchasing).post(`/invoices/${invoice.id}/cancel`, {
      _key: newKey(),
      version: "1",
      reason: "x",
    });
    expect(forbidden.status).toBe(409);
    expect(await forbidden.text()).toContain("権限がありません");
    const closing = await (await as(purchasing).get("/invoices/closing")).text();
    expect(closing).not.toContain("選んだ販売先の請求書を発行する");
    expect((await as(purchasing).get("/invoices/missing")).status).toBe(404);
    expect((await as(purchasing).get("/receipts/missing")).status).toBe(404);
    expect((await as(purchasing).get("/sales-returns/missing")).status).toBe(404);
  });
});
