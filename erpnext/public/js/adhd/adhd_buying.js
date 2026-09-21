// Purchase Order lifecycle and next-action panel.

frappe.provide("erpnext.adhd");

const PURCHASE_ORDER_STEPS = [
	{ id: "created", label: __("Created") },
	{ id: "approved", label: __("Approved") },
	{ id: "receipt_pending", label: __("Receipt Pending") },
	{ id: "invoice_pending", label: __("Invoice Pending") },
	{ id: "closed", label: __("Closed") },
];

function getPurchaseOrderStep(doc) {
	if (doc.status === "Closed" || flt(doc.per_billed) >= 100) return "closed";
	if (doc.docstatus === 0) return "created";
	if (doc.docstatus === 1 && ["Pending Approval", "Waiting for Approval"].includes(doc.workflow_state)) {
		return "approved";
	}
	if (doc.docstatus === 1 && flt(doc.per_received) < 100) return "receipt_pending";
	if (doc.docstatus === 1 && flt(doc.per_billed) < 100) return "invoice_pending";
	return "created";
}

async function addWaitingOn($panel, frm) {
	if (!/(Approval|Pending)/i.test(frm.doc.workflow_state || "") || frm.is_new()) return;
	const result = await frappe.db.get_value(
		"Workflow Action",
		{ reference_doctype: "Purchase Order", reference_name: frm.doc.name, status: "Open" },
		"user",
	);
	const user = result?.message?.user;
	if (user && $panel.closest("body").length) {
		$panel.append(
			$("<p>")
				.addClass("adhd-waiting-on")
				.text(__("Waiting on: {0}", [user])),
		);
	}
}

function initPurchaseOrderStatusPanel(frm) {
	frm.layout.$wrapper.find("#adhd-po-steps").remove();
	if (!erpnext.adhd?.isActive?.() || frm.doctype !== "Purchase Order") return;

	const current = getPurchaseOrderStep(frm.doc);
	const currentIndex = PURCHASE_ORDER_STEPS.findIndex((step) => step.id === current);
	const $panel = $(`
		<div id="adhd-po-steps" class="adhd-po-steps">
			<div class="adhd-po-step-row">
				${PURCHASE_ORDER_STEPS.map(
					(step, index) =>
						`<div class="adhd-step ${
							index < currentIndex
								? "adhd-step--done"
								: index === currentIndex
									? "adhd-step--active"
									: ""
						}">${step.label}</div>`,
				).join("")}
			</div>
		</div>
	`);

	if (current === "receipt_pending") {
		$panel.append(
			$("<button>")
				.addClass("btn btn-primary btn-sm adhd-next-action")
				.text(__("Create Purchase Receipt"))
				.on("click", () =>
					frappe.model.open_mapped_doc({
						method: "erpnext.buying.doctype.purchase_order.mapper.make_purchase_receipt",
						frm,
					}),
				),
		);
	} else if (current === "invoice_pending") {
		$panel.append(
			$("<button>")
				.addClass("btn btn-primary btn-sm adhd-next-action")
				.text(__("Create Purchase Invoice"))
				.on("click", () =>
					frappe.model.open_mapped_doc({
						method: "erpnext.buying.doctype.purchase_order.mapper.make_purchase_invoice",
						frm,
					}),
				),
		);
	}

	const $target = frm.layout.$wrapper.find(".form-dashboard, .page-head").first();
	$target.length ? $target.after($panel) : frm.layout.$wrapper.prepend($panel);
	addWaitingOn($panel, frm);
}

erpnext.adhd.PURCHASE_ORDER_STEPS = PURCHASE_ORDER_STEPS;
erpnext.adhd.getPurchaseOrderStep = getPurchaseOrderStep;
erpnext.adhd.initPurchaseOrderStatusPanel = initPurchaseOrderStatusPanel;
