// Purchase Order lifecycle and next-action panel.

frappe.provide("erpnext.adhd");

const PURCHASE_ORDER_STEPS = [
	{ id: "created", label: __("Created") },
	{ id: "approved", label: __("Approved") },
	{ id: "receipt_pending", label: __("Receipt Pending") },
	{ id: "invoice_pending", label: __("Invoice Pending") },
	{ id: "closed", label: __("Closed") },
];

// Workflow states that mean "waiting for someone to approve". A workflow keeps the document a draft
// (docstatus 0) until that approval submits it, so this is a draft-time state.
const PENDING_APPROVAL_STATE = /(Approval|Pending)/i;

// Mirrors the status rules in erpnext/controllers/status_updater.py for a submitted Purchase Order:
// receiving and billing are tracked separately, so an order that is fully billed can still be waiting for its goods
// ("To Receive"), and the order is only finished once both percentages reach 100 ("Completed").
function getPurchaseOrderStep(doc) {
	// a cancelled order is out of the lifecycle: it is neither "Created" nor any later step
	if (doc.docstatus === 2 || doc.status === "Cancelled") return null;
	if (doc.status === "Closed") return "closed";
	if (doc.docstatus === 0) {
		return PENDING_APPROVAL_STATE.test(doc.workflow_state || "") ? "approved" : "created";
	}
	if (doc.docstatus === 1 && ["Pending Approval", "Waiting for Approval"].includes(doc.workflow_state)) {
		return "approved";
	}
	if (doc.docstatus === 1) {
		// "Delivered" is a drop-ship order whose goods the supplier already delivered: nothing left to receive
		if (doc.status !== "Delivered" && flt(doc.per_received) < 100) return "receipt_pending";
		if (flt(doc.per_billed) < 100) return "invoice_pending";
		return "closed";
	}
	return "created";
}

async function addWaitingOn($panel, frm) {
	if (!PENDING_APPROVAL_STATE.test(frm.doc.workflow_state || "") || frm.is_new()) return;
	const result = await frappe.db.get_value(
		"Workflow Action",
		{ reference_doctype: "Purchase Order", reference_name: frm.doc.name, status: "Open" },
		"user"
	);
	const user = result?.message?.user;
	if (user && $panel.closest("body").length) {
		$panel.append(
			$("<p>")
				.addClass("adhd-waiting-on")
				.text(__("Waiting on: {0}", [user]))
		);
	}
}

function initPurchaseOrderStatusPanel(frm) {
	frm.layout.wrapper.find("#adhd-po-steps").remove();
	if (!erpnext.adhd?.isActive?.() || frm.doctype !== "Purchase Order") return;

	const current = getPurchaseOrderStep(frm.doc);
	if (!current) return;
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
						}">${step.label}</div>`
				).join("")}
			</div>
		</div>
	`);

	// like the standard form, offer no "Create" action while the order is on hold
	const onHold = frm.doc.status === "On Hold";
	if (!onHold && current === "receipt_pending") {
		$panel.append(
			$("<button>")
				.addClass("btn btn-primary btn-sm adhd-next-action")
				.text(__("Create Purchase Receipt"))
				.on("click", () =>
					frappe.model.open_mapped_doc({
						method: "erpnext.buying.doctype.purchase_order.mapper.make_purchase_receipt",
						frm,
					})
				)
		);
	} else if (!onHold && current === "invoice_pending") {
		$panel.append(
			$("<button>")
				.addClass("btn btn-primary btn-sm adhd-next-action")
				.text(__("Create Purchase Invoice"))
				.on("click", () =>
					frappe.model.open_mapped_doc({
						method: "erpnext.buying.doctype.purchase_order.mapper.make_purchase_invoice",
						frm,
					})
				)
		);
	}

	const $target = frm.layout.wrapper.find(".form-dashboard, .page-head").first();
	$target.length ? $target.after($panel) : frm.layout.wrapper.prepend($panel);
	addWaitingOn($panel, frm);
}

erpnext.adhd.PURCHASE_ORDER_STEPS = PURCHASE_ORDER_STEPS;
erpnext.adhd.getPurchaseOrderStep = getPurchaseOrderStep;
erpnext.adhd.initPurchaseOrderStatusPanel = initPurchaseOrderStatusPanel;
