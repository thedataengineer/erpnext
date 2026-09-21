// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Document Chain Navigator
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

const CHAIN_MAP = {
	Quotation: [
		{ label: "Quotation", doctype: "Quotation", link_field: null },
		{
			label: "Sales Order",
			doctype: "Sales Order",
			link_field: "prevdoc_docname",
			map_method: "erpnext.selling.doctype.quotation.mapper.make_sales_order",
		},
		{
			label: "Delivery Note",
			doctype: "Delivery Note",
			link_field: "against_sales_order",
			map_method: "erpnext.selling.doctype.sales_order.mapper.make_delivery_note",
			source_doctype: "Sales Order",
		},
		{
			label: "Sales Invoice",
			doctype: "Sales Invoice",
			link_field: "sales_order",
			map_method: "erpnext.selling.doctype.sales_order.mapper.make_sales_invoice",
			source_doctype: "Sales Order",
		},
		{
			label: "Payment Entry",
			doctype: "Payment Entry",
			link_field: "reference_name",
			payment_reference_doctypes: ["Sales Order", "Sales Invoice"],
		},
	],
	"Sales Order": [
		{ label: "Quotation", doctype: "Quotation", link_field: "prevdoc_docname" },
		{ label: "Sales Order", doctype: "Sales Order", link_field: null },
		{
			label: "Delivery Note",
			doctype: "Delivery Note",
			link_field: "against_sales_order",
			map_method: "erpnext.selling.doctype.sales_order.mapper.make_delivery_note",
		},
		{
			label: "Sales Invoice",
			doctype: "Sales Invoice",
			link_field: "sales_order",
			map_method: "erpnext.selling.doctype.sales_order.mapper.make_sales_invoice",
		},
		{
			label: "Payment Entry",
			doctype: "Payment Entry",
			link_field: "reference_name",
			payment_reference_doctypes: ["Sales Order", "Sales Invoice"],
		},
	],
	"Delivery Note": [
		{ label: "Sales Order", doctype: "Sales Order", link_field: "against_sales_order" },
		{ label: "Delivery Note", doctype: "Delivery Note", link_field: null },
		{
			label: "Sales Invoice",
			doctype: "Sales Invoice",
			link_field: "delivery_note",
			map_method: "erpnext.stock.doctype.delivery_note.mapper.make_sales_invoice",
		},
		{
			label: "Payment Entry",
			doctype: "Payment Entry",
			link_field: "reference_name",
			payment_reference_doctypes: ["Sales Invoice"],
		},
	],
	"Sales Invoice": [
		{ label: "Sales Order", doctype: "Sales Order", link_field: "sales_order" },
		{ label: "Delivery Note", doctype: "Delivery Note", link_field: "delivery_note" },
		{ label: "Sales Invoice", doctype: "Sales Invoice", link_field: null },
		{
			label: "Payment Entry",
			doctype: "Payment Entry",
			link_field: "reference_name",
			payment_reference_doctypes: ["Sales Invoice"],
		},
	],
	"Purchase Order": [
		{ label: "Purchase Order", doctype: "Purchase Order", link_field: null },
		{
			label: "Purchase Receipt",
			doctype: "Purchase Receipt",
			link_field: "purchase_order",
			map_method: "erpnext.buying.doctype.purchase_order.mapper.make_purchase_receipt",
		},
		{
			label: "Purchase Invoice",
			doctype: "Purchase Invoice",
			link_field: "purchase_order",
			map_method: "erpnext.buying.doctype.purchase_order.mapper.make_purchase_invoice",
		},
		{
			label: "Payment Entry",
			doctype: "Payment Entry",
			link_field: "reference_name",
			payment_reference_doctypes: ["Purchase Order", "Purchase Invoice"],
		},
	],
	"Purchase Receipt": [
		{ label: "Purchase Order", doctype: "Purchase Order", link_field: "purchase_order" },
		{ label: "Purchase Receipt", doctype: "Purchase Receipt", link_field: null },
		{
			label: "Purchase Invoice",
			doctype: "Purchase Invoice",
			link_field: "purchase_receipt",
			map_method: "erpnext.stock.doctype.purchase_receipt.mapper.make_purchase_invoice",
		},
		{
			label: "Payment Entry",
			doctype: "Payment Entry",
			link_field: "reference_name",
			payment_reference_doctypes: ["Purchase Invoice"],
		},
	],
	"Purchase Invoice": [
		{ label: "Purchase Order", doctype: "Purchase Order", link_field: "purchase_order" },
		{ label: "Purchase Receipt", doctype: "Purchase Receipt", link_field: "purchase_receipt" },
		{ label: "Purchase Invoice", doctype: "Purchase Invoice", link_field: null },
		{
			label: "Payment Entry",
			doctype: "Payment Entry",
			link_field: "reference_name",
			payment_reference_doctypes: ["Purchase Invoice"],
		},
	],
	"Payment Entry": [],
};

const PAYMENT_REFERENCE_DOCTYPES = ["Sales Order", "Sales Invoice", "Purchase Order", "Purchase Invoice"];
const LINKED_DOC_CACHE = {};
const DOCSTATUS_CACHE = {};
const REGISTERED_DOCTYPES = Object.keys(CHAIN_MAP);

function isADHDModeActive() {
	return Boolean(frappe.boot && frappe.boot.adhd_mode);
}

// Drop cached link/docstatus lookups. With no argument (a save, submit or cancel
// changed some document's state) everything goes; otherwise only the given form's own entries.
function invalidateChainCaches(frm) {
	if (!frm) {
		Object.keys(LINKED_DOC_CACHE).forEach((key) => delete LINKED_DOC_CACHE[key]);
		Object.keys(DOCSTATUS_CACHE).forEach((key) => delete DOCSTATUS_CACHE[key]);
		return;
	}
	if (!frm.doc || !frm.doc.name) return;
	delete LINKED_DOC_CACHE[getLinkedCacheKey(frm)];
	delete DOCSTATUS_CACHE[`${frm.doctype}::${frm.doc.name}`];
}

function removeChainNav(frm) {
	if (!frm || !frm.$wrapper) return;
	frm.$wrapper.find(".adhd-chain-nav").remove();
}

function getChainForForm(frm) {
	if (!frm || !frm.doc) return [];

	if (frm.doctype !== "Payment Entry") {
		return CHAIN_MAP[frm.doctype] || [];
	}

	const references = getPaymentReferences(frm.doc);
	const firstReference = references.find((row) =>
		PAYMENT_REFERENCE_DOCTYPES.includes(row.reference_doctype)
	);
	if (!firstReference) {
		return [
			{ label: "Reference Document", doctype: "Reference Document", link_field: "reference_name" },
			{ label: "Payment Entry", doctype: "Payment Entry", link_field: null },
		];
	}

	const chain = CHAIN_MAP[firstReference.reference_doctype] || [];
	return chain.filter((step) => step.doctype !== "Quotation");
}

function getPaymentReferences(doc) {
	return (doc.references || []).filter((row) => row.reference_doctype && row.reference_name);
}

function getLocalLinkedNames(doc, doctype) {
	const names = new Set();

	if (!doc) return names;
	if (doc.doctype === doctype && doc.name) names.add(doc.name);

	const parentFields = [
		"prevdoc_docname",
		"quotation",
		"sales_order",
		"delivery_note",
		"purchase_order",
		"purchase_receipt",
		"purchase_invoice",
		"against_sales_order",
		"against_sales_invoice",
		"reference_name",
	];

	parentFields.forEach((fieldname) => {
		if (doc[fieldname]) names.add(doc[fieldname]);
	});

	(doc.items || []).forEach((row) => {
		[
			"prevdoc_docname",
			"sales_order",
			"against_sales_order",
			"delivery_note",
			"against_sales_invoice",
			"purchase_order",
			"purchase_receipt",
			"purchase_invoice",
		].forEach((fieldname) => {
			if (row[fieldname]) names.add(row[fieldname]);
		});
	});

	getPaymentReferences(doc).forEach((row) => {
		if (row.reference_doctype === doctype) names.add(row.reference_name);
	});

	return names;
}

function getLinkedCacheKey(frm) {
	return `${frm.doctype}::${frm.docname || frm.doc.name || "new"}`;
}

async function getLinkedDocs(frm) {
	if (!frm || !frm.doc || frm.doc.__islocal === true) return {};

	const cacheKey = getLinkedCacheKey(frm);
	if (LINKED_DOC_CACHE[cacheKey]) return LINKED_DOC_CACHE[cacheKey];

	LINKED_DOC_CACHE[cacheKey] = frappe
		.xcall("frappe.desk.form.linked_with.get", {
			doctype: frm.doctype,
			docname: frm.doc.name,
		})
		.catch((error) => {
			console.warn("[ADHD Chain Navigator] Could not load linked documents", error);
			return {};
		});

	return LINKED_DOC_CACHE[cacheKey];
}

function getDocsForDoctype(linkedDocs, doctype) {
	const linked = linkedDocs && linkedDocs[doctype];
	if (!linked) return [];
	if (Array.isArray(linked)) return linked;
	return linked.docs || [];
}

function getDocName(doc) {
	return doc.name || doc.value || doc.label;
}

async function getDocstatus(doctype, name) {
	if (!doctype || !name || doctype === "Reference Document") return 0;

	const cacheKey = `${doctype}::${name}`;
	if (DOCSTATUS_CACHE[cacheKey] !== undefined) return DOCSTATUS_CACHE[cacheKey];

	DOCSTATUS_CACHE[cacheKey] = frappe.db
		.get_value(doctype, name, "docstatus")
		.then((response) => cint(response && response.message && response.message.docstatus))
		.catch(() => 0);

	return DOCSTATUS_CACHE[cacheKey];
}

// linked_with already returns docstatus for every linked doc, so only names that
// come from the form's own fields need a separate lookup.
async function getLinkedDocstatus(doctype, linkedDoc) {
	if (linkedDoc.docstatus !== undefined && linkedDoc.docstatus !== null) {
		return cint(linkedDoc.docstatus);
	}
	return getDocstatus(doctype, getDocName(linkedDoc));
}

async function findSubmittedLinkedName(frm, doctype, linkedDocs) {
	const knownStatus = new Map();
	const linkedNames = getLocalLinkedNames(frm.doc, doctype);
	getDocsForDoctype(linkedDocs, doctype).forEach((linkedDoc) => {
		const name = getDocName(linkedDoc);
		if (!name) return;
		linkedNames.add(name);
		if (linkedDoc.docstatus !== undefined && linkedDoc.docstatus !== null) {
			knownStatus.set(name, cint(linkedDoc.docstatus));
		}
	});

	for (const name of linkedNames) {
		const status = knownStatus.has(name) ? knownStatus.get(name) : await getDocstatus(doctype, name);
		if (status === 1) return name;
	}

	return null;
}

async function getStepStatus(frm, step, linkedDocs) {
	if (!isADHDModeActive()) return "pending";
	if (!frm || !frm.doc || !step) return "pending";
	if (step.doctype === frm.doctype) return "current";

	return (await findSubmittedLinkedName(frm, step.doctype, linkedDocs)) ? "done" : "pending";
}

async function getStepStatuses(frm, chain) {
	const linkedDocs = await getLinkedDocs(frm);
	return Promise.all(chain.map((step) => getStepStatus(frm, step, linkedDocs)));
}

function makeStepElement(step, status) {
	const $step = $("<span>")
		.addClass("adhd-chain-step")
		.addClass(`adhd-step--${status}`)
		.attr("title", __(step.doctype))
		.text(`${status === "done" ? "✓ " : ""}${__(step.label)}`);

	return $step;
}

function getNextPendingStep(frm, chain, statuses) {
	const currentIndex = chain.findIndex((step) => step.doctype === frm.doctype);
	if (currentIndex === -1) return null;

	for (let index = currentIndex + 1; index < chain.length; index++) {
		if (statuses[index] === "pending") return chain[index];
	}

	return null;
}

// The mapper runs on `source_doctype` (default: the document on screen). When the
// form is a different document, use the submitted one from the chain instead of
// passing this form's name to a mapper that expects another doctype.
async function resolveMapSource(frm, nextStep) {
	if (!nextStep || !nextStep.map_method) return null;
	if (!nextStep.source_doctype || nextStep.source_doctype === frm.doctype) return { frm };

	const linkedDocs = await getLinkedDocs(frm);
	const name = await findSubmittedLinkedName(frm, nextStep.source_doctype, linkedDocs);
	return name ? { source_name: name } : null;
}

async function resolvePaymentReference(frm, nextStep) {
	const allowedDoctypes = nextStep.payment_reference_doctypes || PAYMENT_REFERENCE_DOCTYPES;
	if (allowedDoctypes.includes(frm.doctype)) {
		return { doctype: frm.doctype, name: frm.doc.name };
	}

	const linkedDocs = await getLinkedDocs(frm);
	for (const doctype of allowedDoctypes) {
		const linked = getDocsForDoctype(linkedDocs, doctype);
		for (const linkedDoc of linked) {
			const name = getDocName(linkedDoc);
			if (name && (await getLinkedDocstatus(doctype, linkedDoc)) === 1) {
				return { doctype, name };
			}
		}
	}

	return null;
}

async function createPaymentEntry(frm, nextStep) {
	const reference = await resolvePaymentReference(frm, nextStep);
	if (!reference) {
		frappe.show_alert({
			message: __("Create or submit the linked invoice/order before creating payment."),
			indicator: "orange",
		});
		return;
	}

	return frappe.call({
		method: "erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry",
		args: {
			dt: reference.doctype,
			dn: reference.name,
		},
		freeze: true,
		callback: function (response) {
			if (!response.exc) {
				const doclist = frappe.model.sync(response.message);
				frappe.set_route("Form", doclist[0].doctype, doclist[0].name);
			}
		},
	});
}

function copyItems(doc) {
	return (doc.items || []).map((row) => {
		const item = {};
		[
			"item_code",
			"item_name",
			"description",
			"qty",
			"uom",
			"stock_uom",
			"conversion_factor",
			"rate",
			"amount",
			"warehouse",
			"expense_account",
			"income_account",
			"cost_center",
			"project",
		].forEach((fieldname) => {
			if (row[fieldname] !== undefined) item[fieldname] = row[fieldname];
		});
		return item;
	});
}

function getFallbackPrefill(frm) {
	const prefill = {};
	[
		"customer",
		"supplier",
		"company",
		"currency",
		"selling_price_list",
		"buying_price_list",
		"price_list_currency",
		"conversion_rate",
		"plc_conversion_rate",
		"transaction_date",
		"posting_date",
		"due_date",
		"project",
	].forEach((fieldname) => {
		if (frm.doc[fieldname] !== undefined) prefill[fieldname] = frm.doc[fieldname];
	});

	const items = copyItems(frm.doc);
	if (items.length) prefill.items = items;

	return prefill;
}

async function openNextStep(frm, nextStep) {
	if (!isADHDModeActive() || !nextStep) return;

	if (frm.doc.__islocal === true) {
		frappe.show_alert({
			message: __("Save this document before creating the next step."),
			indicator: "orange",
		});
		return;
	}

	if (nextStep.doctype === "Payment Entry") {
		return createPaymentEntry(frm, nextStep);
	}

	if (nextStep.map_method) {
		const source = await resolveMapSource(frm, nextStep);
		if (!source) {
			frappe.show_alert({
				message: __("Create and submit the {0} first.", [__(nextStep.source_doctype)]),
				indicator: "orange",
			});
			return;
		}
		return frappe.model.open_mapped_doc({
			method: nextStep.map_method,
			...source,
			freeze: true,
		});
	}

	return frappe.new_doc(nextStep.doctype, getFallbackPrefill(frm));
}

function insertChainNav(frm, $nav) {
	if (!frm || !frm.$wrapper) return;

	const $formPage = frm.$wrapper.find(".form-page").first();
	const $pageHead = frm.$wrapper.find(".page-head").first();

	if ($formPage.length) {
		$formPage.before($nav);
	} else if ($pageHead.length) {
		$pageHead.after($nav);
	} else {
		frm.$wrapper.prepend($nav);
	}
}

async function renderChainNav(frm) {
	if (!isADHDModeActive()) {
		removeChainNav(frm);
		return;
	}

	if (!frm || !frm.doc || !frm.$wrapper) return;

	const chain = getChainForForm(frm);
	if (!chain.length) return;

	// after_save is followed by refresh, so renders overlap: only the newest one may insert
	const token = (frm._adhdChainToken || 0) + 1;
	frm._adhdChainToken = token;
	removeChainNav(frm);

	const statuses = await getStepStatuses(frm, chain);
	if (token !== frm._adhdChainToken || !isADHDModeActive()) return;

	const $nav = $('<div class="adhd-chain-nav" role="navigation" aria-label="Document workflow chain">');
	const $steps = $('<div class="adhd-chain-steps">');
	chain.forEach((step, index) => {
		$steps.append(makeStepElement(step, statuses[index]));
	});
	$nav.append($steps);

	const nextStep = getNextPendingStep(frm, chain, statuses);
	if (nextStep) {
		const disabled = frm.doc.__islocal === true;
		const $button = $('<button type="button" class="btn btn-xs btn-primary adhd-chain-next">')
			.text(__("Create Next Step → {0}", [nextStep.label]))
			.prop("disabled", disabled)
			.attr(
				"title",
				disabled
					? __("Save this document before creating the next step.")
					: __("Create the next workflow document")
			)
			.on("click", () => openNextStep(frm, nextStep));

		$nav.append($button);
	}

	removeChainNav(frm);
	insertChainNav(frm, $nav);
}

REGISTERED_DOCTYPES.forEach((doctype) => {
	frappe.ui.form.on(doctype, {
		refresh(frm) {
			invalidateChainCaches(frm);
			renderChainNav(frm);
		},
		after_save(frm) {
			invalidateChainCaches();
			renderChainNav(frm);
		},
		on_submit(frm) {
			invalidateChainCaches();
			renderChainNav(frm);
		},
		after_cancel(frm) {
			invalidateChainCaches();
			renderChainNav(frm);
		},
	});
});

erpnext.adhd.CHAIN_MAP = CHAIN_MAP;
erpnext.adhd.renderChainNav = renderChainNav;
erpnext.adhd.invalidateChainCaches = invalidateChainCaches;
erpnext.adhd.findSubmittedLinkedName = findSubmittedLinkedName;
erpnext.adhd.resolveMapSource = resolveMapSource;
erpnext.adhd.getStepStatus = getStepStatus;
