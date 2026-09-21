// Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors

(() => {
	const FocusPanel = erpnext.adhd.FocusPanel;
	const originalTimerComplete = FocusPanel.prototype._timerComplete;

	FocusPanel.prototype.startTimer = function (minutes) {
		const duration = Number(minutes) || 25;
		this.timerMode = "work";
		this._timerReset(duration * 60);
		this._timerStart();
		this.show();
	};

	FocusPanel.prototype.open = function () {
		this.show();
	};

	FocusPanel.prototype._timerComplete = function () {
		// The focus panel returns { mode: "work" | "break", minutes } for the session that just ran out: pass it on
		// so a listener can tell a finished break from a finished work session.
		const result = originalTimerComplete.call(this);
		document.dispatchEvent(new CustomEvent("focuspanel:timercomplete", { detail: result ?? null }));
		return result;
	};
})();
