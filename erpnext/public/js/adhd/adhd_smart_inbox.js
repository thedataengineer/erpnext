// Copyright (c) 2024, ERPNext Contributors
// ADHD-Friendly Mode: Smart Inbox
// License: GNU General Public License v3. See license.txt

frappe.provide("erpnext.adhd");

(() => {
	const RECENT_STORAGE_KEY = "adhd_recent_docs";
	const RESUME_STORAGE_KEY = "adhd_resume_docs";
	const MODULES = ["Accounting", "Buying", "Stock", "Selling", "Manufacturing", "Projects", "Support"];
	const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
	let refreshInterval = null;
	let recentTrackerRegistered = false;
	let redirectScheduled = false;

	function hasBootADHDFlag() {
		return Boolean(frappe.boot && Object.prototype.hasOwnProperty.call(frappe.boot, "adhd_mode"));
	}

	function isADHDModeActive() {
		if (hasBootADHDFlag()) {
			return Boolean(frappe.boot.adhd_mode);
		}

		return Boolean(erpnext.adhd && erpnext.adhd.isActive && erpnext.adhd.isActive());
	}

	function getPanelBody(panelKey) {
		return $(`.adhd-panel-${panelKey} .adhd-panel-body`);
	}

	function escapeHTML(value) {
		return frappe.utils.escape_html(value == null ? "" : String(value));
	}

	function frequencyKey() {
		return `adhd_module_freq_${frappe.session.user}`;
	}

	// The document titles are per person: another user of the same browser must not see them.
	function recentKey() {
		return `${RECENT_STORAGE_KEY}_${frappe.session.user}`;
	}

	function resumeKey() {
		return `${RESUME_STORAGE_KEY}_${frappe.session.user}`;
	}

	// Before the keys carried the user, one shared copy held whoever saved last.
	function removeSharedRecentDocs() {
		try {
			localStorage.removeItem(RECENT_STORAGE_KEY);
			localStorage.removeItem(RESUME_STORAGE_KEY);
		} catch {
			// storage is unavailable; there is nothing to remove
		}
	}

	function moduleSlug(moduleName) {
		return String(moduleName).toLowerCase().replaceAll(" ", "-");
	}

	function loadFrequencyStore() {
		try {
			return JSON.parse(localStorage.getItem(frequencyKey())) || {};
		} catch {
			return {};
		}
	}

	function recordVisit(moduleName) {
		if (!isADHDModeActive() || !moduleName || !MODULES.includes(moduleName)) return;
		const store = loadFrequencyStore();
		const dow = String(new Date().getDay());
		store[moduleName] ||= {};
		store[moduleName][dow] = (store[moduleName][dow] || 0) + 1;
		localStorage.setItem(frequencyKey(), JSON.stringify(store));
		const dates = new Set(JSON.parse(localStorage.getItem("adhd_session_dates") || "[]"));
		dates.add(frappe.datetime.get_today());
		localStorage.setItem("adhd_session_dates", JSON.stringify([...dates]));
	}

	function getRankedModules() {
		const store = loadFrequencyStore();
		const dow = String(new Date().getDay());
		return Object.keys(store)
			.filter((moduleName) => (store[moduleName]?.[dow] || 0) > 0)
			.sort((left, right) => store[right][dow] - store[left][dow]);
	}

	function clearFrequencyStore() {
		localStorage.removeItem(frequencyKey());
		localStorage.removeItem("adhd_session_dates");
	}

	function renderModuleSuggestions($body) {
		const store = loadFrequencyStore();
		const ranked = getRankedModules();
		const dow = String(new Date().getDay());
		const sessionDates = JSON.parse(localStorage.getItem("adhd_session_dates") || "[]");
		const hideUnvisited = sessionDates.length >= 30;
		const ordered = [...ranked, ...MODULES.filter((moduleName) => !ranked.includes(moduleName))];
		const cards = ordered
			.map((moduleName, index) => {
				const total = Object.values(store[moduleName] || {}).reduce(
					(sum, count) => sum + Number(count),
					0
				);
				const hidden = hideUnvisited && total === 0;
				return `<a href="/desk/${moduleSlug(moduleName)}"
					class="adhd-module-card ${hidden ? "adhd-module-hidden" : ""}"
					data-module="${moduleName}" style="order:${index + 1}">
					<span>${escapeHTML(__(moduleName))}</span>
					${index === 0 && ranked.length ? `<small>${__("📌 Your top module today")}</small>` : ""}
				</a>`;
			})
			.join("");
		const top = ranked[0];
		const count = top ? store[top]?.[dow] || 0 : 0;
		const today = frappe.datetime.get_today().replaceAll("-", "_");
		const dismissalKey = `adhd_suggestion_dismissed_${today}`;
		const banner =
			top && count >= 3 && !localStorage.getItem(dismissalKey)
				? `<div class="adhd-suggestion-banner">
					<a href="/desk/${moduleSlug(top)}">${__("📅 You usually work on {0} on {1}. Start there?", [
						top,
						new Date().toLocaleDateString(undefined, { weekday: "long" }),
				  ])}</a>
					<button type="button" aria-label="${__("Dismiss")}">×</button>
				</div>`
				: "";
		$body.prepend(`
			${banner}
			<section class="adhd-module-section">
				<h3>${__("Your modules")}</h3>
				<div class="adhd-module-cards">${cards}</div>
				${
					hideUnvisited
						? `<button class="btn btn-xs btn-default adhd-show-all">${__(
								"Show all modules"
						  )}</button>`
						: ""
				}
			</section>
		`);
		$body.find(".adhd-suggestion-banner button").on("click", (event) => {
			localStorage.setItem(dismissalKey, "1");
			$(event.currentTarget).closest(".adhd-suggestion-banner").remove();
		});
		$body.find(".adhd-show-all").on("click", (event) => {
			$body.find(".adhd-module-hidden").removeClass("adhd-module-hidden");
			$(event.currentTarget).remove();
		});
	}

	function makeSkeleton() {
		return `
			<div class="adhd-skeleton" aria-hidden="true"></div>
			<div class="adhd-skeleton" aria-hidden="true"></div>
			<div class="adhd-skeleton" aria-hidden="true"></div>
		`;
	}

	function makeEmptyState(message) {
		return `<div class="adhd-inbox-empty">${escapeHTML(__(message))}</div>`;
	}

	function openForm(doctype, name) {
		if (!doctype || !name) return;
		frappe.set_route("Form", doctype, name);
	}

	function makeLink(item, label) {
		const doctype = item.doctype || item.reference_type;
		const name = item.name || item.reference_name;
		return $("<a>")
			.addClass("adhd-inbox-link")
			.attr("href", "#")
			.attr("data-doctype", doctype)
			.attr("data-name", name)
			.text(label || name)
			.on("click", (event) => {
				event.preventDefault();
				openForm(doctype, name);
			});
	}

	function renderRows($body, items, emptyMessage, rowBuilder) {
		$body.empty();

		if (!items || !items.length) {
			$body.html(makeEmptyState(emptyMessage));
			return;
		}

		const $list = $("<ul>").addClass("adhd-inbox-list");
		items.forEach((item) => $list.append(rowBuilder(item)));
		$body.append($list);
	}

	function renderError($body, message) {
		$body.html(`<div class="adhd-inbox-empty adhd-inbox-error">${escapeHTML(__(message))}</div>`);
	}

	function badgeClass(value) {
		return value === "overdue" ? "adhd-badge-danger" : "adhd-badge-warning";
	}

	function loadUrgentItems() {
		if (!isADHDModeActive()) return Promise.resolve();

		const $body = getPanelBody("overdue");
		$body.html(makeSkeleton());

		return frappe
			.call({
				method: "erpnext.adhd.api.get_urgent_items",
				args: { user: frappe.session.user },
			})
			.then((response) => {
				const items = response.message || [];
				renderRows($body, items, "🎉 Nothing overdue or due today.", (item) => {
					const isOverdue = item.urgency === "overdue";
					const badge = isOverdue ? "🔴 " + __("Overdue") : "🟡 " + __("Due Today");
					const $row = $("<li>").addClass("adhd-inbox-row adhd-inbox-urgent-row");
					const $main = $("<div>").addClass("adhd-inbox-row-main");
					$main.append(
						$("<span>").addClass("adhd-doctype-pill").text(item.doctype),
						makeLink(item, item.title || item.name)
					);
					if (item.counterparty) {
						$main.append($("<span>").addClass("adhd-inbox-meta").text(item.counterparty));
					}
					$row.append(
						$main,
						$("<span>")
							.addClass(`adhd-inbox-badge ${badgeClass(item.urgency)}`)
							.text(badge)
					);
					return $row;
				});
			})
			.catch((error) => {
				console.warn("[ADHD Smart Inbox] Could not load urgent items", error);
				renderError($body, "Could not load urgent items. Try Refresh.");
			});
	}

	function loadActionQueue() {
		if (!isADHDModeActive()) return Promise.resolve();

		const $body = getPanelBody("awaiting");
		$body.html(makeSkeleton());

		return frappe
			.call({
				method: "erpnext.adhd.api.get_action_queue",
				args: { user: frappe.session.user },
			})
			.then((response) => {
				const items = response.message || [];
				renderRows($body, items, "✅ No pending approvals or todos.", (item) => {
					const $row = $("<li>").addClass("adhd-inbox-row adhd-inbox-action-row");
					const $main = $("<div>").addClass("adhd-inbox-row-main");
					$main.append(makeLink(item, item.title || item.name));
					if (item.status) {
						$main.append($("<span>").addClass("adhd-inbox-meta").text(item.status));
					}
					$row.append(
						$main,
						$("<span>").addClass("adhd-inbox-badge adhd-badge-action").text(item.type)
					);
					return $row;
				});
			})
			.catch((error) => {
				console.warn("[ADHD Smart Inbox] Could not load action queue", error);
				renderError($body, "Could not load your action queue. Try Refresh.");
			});
	}

	function parseStoredDocs(key) {
		try {
			const raw = localStorage.getItem(key);
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		} catch (error) {
			console.warn(`[ADHD Smart Inbox] Ignoring malformed ${key}`, error);
			return [];
		}
	}

	function getRecentDocs() {
		const docs = [...parseStoredDocs(recentKey()), ...parseStoredDocs(resumeKey())]
			.map((doc) => ({
				doctype: doc.doctype,
				name: doc.name || doc.docname,
				title: doc.title || doc.name || doc.docname,
				timestamp: doc.timestamp,
			}))
			.filter((doc) => doc.doctype && doc.name);

		const deduped = [];
		const seen = new Set();
		docs.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0)).forEach((doc) => {
			const key = `${doc.doctype}::${doc.name}`;
			if (seen.has(key)) return;
			seen.add(key);
			deduped.push(doc);
		});

		return deduped;
	}

	function saveRecentDoc(entry) {
		const updated = [
			entry,
			...getRecentDocs().filter((doc) => !(doc.doctype === entry.doctype && doc.name === entry.name)),
		].slice(0, 10);
		localStorage.setItem(recentKey(), JSON.stringify(updated));
		localStorage.setItem(
			resumeKey(),
			JSON.stringify(updated.map((doc) => ({ ...doc, docname: doc.name })))
		);
	}

	function trackSavedForm(frm) {
		if (!isADHDModeActive() || !frm || !frm.doc || !frm.doctype || !frm.doc.name) return;

		const entry = {
			doctype: frm.doctype,
			name: frm.doc.name,
			title:
				frm.doc.title ||
				frm.doc.subject ||
				frm.doc.customer_name ||
				frm.doc.supplier_name ||
				frm.doc.name,
			timestamp: new Date().toISOString(),
		};
		saveRecentDoc(entry);
	}

	// The Resume panel and the unsaved-draft banner (ADHD-023) share one slot on a form. The offer is
	// idempotent, so asking on every refresh cannot stack a second banner.
	function offerDraftRestore(frm) {
		try {
			const recovery = erpnext.adhd.draftRecovery;
			if (recovery && recovery.checkAndOfferDraftRestore) recovery.checkAndOfferDraftRestore(frm);
		} catch (error) {
			console.warn("[ADHD Smart Inbox] Could not offer the saved draft", error);
		}
	}

	function registerRecentTracker() {
		if (recentTrackerRegistered) return;
		if (!(frappe.ui && frappe.ui.form && frappe.ui.form.ScriptManager)) return;

		const originalTrigger = frappe.ui.form.ScriptManager.prototype.trigger;
		frappe.ui.form.ScriptManager.prototype.trigger = function (...args) {
			const result = originalTrigger.apply(this, args);
			const eventName = args && args[0];
			if (eventName === "after_save") {
				trackSavedForm(this.frm);
			} else if (eventName === "refresh") {
				offerDraftRestore(this.frm);
			}
			return result;
		};
		recentTrackerRegistered = true;
	}

	function loadResumeItems() {
		if (!isADHDModeActive()) return;

		const $body = getPanelBody("resume");
		const docs = getRecentDocs().slice(0, 3);
		renderRows($body, docs, "Open any document to start tracking your session.", (item) => {
			const $row = $("<li>").addClass("adhd-inbox-row adhd-inbox-resume-row");
			const $main = $("<div>").addClass("adhd-inbox-row-main");
			$main.append(
				$("<span>").addClass("adhd-doctype-pill").text(item.doctype),
				makeLink(item, item.title || item.name)
			);
			$row.append(
				$main,
				$("<span>")
					.addClass("adhd-inbox-time")
					.text(item.timestamp ? frappe.datetime.prettyDate(item.timestamp) : "")
			);
			return $row;
		});
	}

	function clearResumeItems() {
		localStorage.removeItem(recentKey());
		localStorage.removeItem(resumeKey());
		loadResumeItems();
	}

	function refreshSmartInbox() {
		return Promise.all([loadUrgentItems(), loadActionQueue()]).then(() => loadResumeItems());
	}

	function clearRefreshInterval() {
		if (refreshInterval) {
			clearInterval(refreshInterval);
			refreshInterval = null;
		}
	}

	function setupRefreshInterval() {
		clearRefreshInterval();
		refreshInterval = setInterval(() => {
			if (!isADHDModeActive() || frappe.get_route_str() !== "focus-inbox") {
				clearRefreshInterval();
				return;
			}
			loadUrgentItems();
			loadActionQueue();
		}, REFRESH_INTERVAL_MS);
	}

	function renderSmartInbox(page) {
		if (!isADHDModeActive()) {
			clearRefreshInterval();
			return;
		}

		registerRecentTracker();

		page.clear_inner_toolbar && page.clear_inner_toolbar();
		page.set_primary_action &&
			page.set_primary_action(__("↻ Refresh"), () => refreshSmartInbox(), "refresh");

		const $body = $(page.body);
		$body.html(`
			<div class="adhd-smart-inbox" role="region" aria-label="${escapeHTML(__("Your Day At a Glance"))}">
				<section class="adhd-inbox-panel adhd-panel-overdue">
					<header class="adhd-panel-header">
						<h3>${escapeHTML(__("⚠️ Overdue & Due Today"))}</h3>
					</header>
					<div class="adhd-panel-body">${makeSkeleton()}</div>
				</section>
				<section class="adhd-inbox-panel adhd-panel-awaiting">
					<header class="adhd-panel-header">
						<h3>${escapeHTML(__("⏳ Awaiting Your Action"))}</h3>
					</header>
					<div class="adhd-panel-body">${makeSkeleton()}</div>
				</section>
				<section class="adhd-inbox-panel adhd-panel-resume">
					<header class="adhd-panel-header">
						<h3>${escapeHTML(__("▶ Resume Where You Left Off"))}</h3>
						<button type="button" class="btn btn-xs btn-default adhd-resume-clear">${escapeHTML(__("Clear"))}</button>
					</header>
					<div class="adhd-panel-body">${makeSkeleton()}</div>
				</section>
			</div>
		`);
		renderModuleSuggestions($body);
		$body.find(".adhd-resume-clear").on("click", clearResumeItems);

		refreshSmartInbox();
		setupRefreshInterval();
	}

	function shouldRedirectToInbox() {
		if (!isADHDModeActive()) return false;
		if (frappe.get_route_str && frappe.get_route_str() === "focus-inbox") return false;
		if (sessionStorage.getItem("adhd_inbox_redirected") === "1") return false;

		const homePage = frappe.boot && frappe.boot.desk_settings && frappe.boot.desk_settings.home_page;
		return homePage !== "focus-inbox";
	}

	function schedulePostLoginRedirect() {
		if (redirectScheduled) return;
		redirectScheduled = true;

		setTimeout(() => {
			redirectScheduled = false;
			if (!shouldRedirectToInbox()) return;

			const route = frappe.get_route();
			const routeType = route && route[0];
			const isDeskLanding =
				!routeType ||
				routeType === "Workspaces" ||
				routeType === "workspace" ||
				frappe.get_route_str() === "";
			if (!isDeskLanding) return;

			sessionStorage.setItem("adhd_inbox_redirected", "1");
			frappe.set_route("focus-inbox");
		}, 600);
	}

	// Bookmarks, browser history and a Home Page setting from before these pages were renamed still open them.
	if (frappe.re_route) {
		frappe.re_route["adhd-inbox"] = "focus-inbox";
		frappe.re_route["adhd-task-board"] = "focus-task-board";
	}

	frappe.router.on("change", () => {
		const route = frappe.get_route();
		const candidate = route?.[0]?.toLowerCase() === "workspaces" ? route[1] : route?.[0];
		const moduleName = MODULES.find(
			(module) => moduleSlug(module) === String(candidate || "").toLowerCase()
		);
		recordVisit(moduleName);
		if (frappe.get_route_str && frappe.get_route_str() !== "focus-inbox") {
			clearRefreshInterval();
		}
	});

	frappe.after_ajax(() => {
		removeSharedRecentDocs();
		registerRecentTracker();
		schedulePostLoginRedirect();
	});

	erpnext.adhd.renderSmartInbox = renderSmartInbox;
	erpnext.adhd.smartInbox = {
		loadUrgentItems,
		loadActionQueue,
		refreshResumeItems: loadResumeItems,
		refresh: refreshSmartInbox,
		startAutoRefresh: setupRefreshInterval,
		recordVisit,
		getRankedModules,
		clearStore: clearFrequencyStore,
	};
})();
