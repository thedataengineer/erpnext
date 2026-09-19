# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""Small deterministic parsers that back up the language model.

A local model is good at understanding a sentence and unreliable at exact values, so the
values the user cares most about (hours, dates) are also parsed here and checked.
"""

import re
from datetime import date, datetime, timedelta
from typing import Any

from dateutil import parser as dateparser
from frappe.utils import getdate

_NUM = r"(\d+(?:\.\d+)?)"
_H = r"(?:h|hr|hrs|hour|hours)"
_M = r"(?:m|min|mins|minute|minutes)"

_CLOCK = re.compile(r"^(\d{1,2}):(\d{2})$")
_H_AND_M = re.compile(rf"\b{_NUM}\s*{_H}(?![a-z])\s*(?:and\s*)?(\d+)\s*(?:{_M}(?![a-z]))?(?![\d.])")
_H_ONLY = re.compile(rf"\b{_NUM}\s*{_H}(?![a-z])")
_M_ONLY = re.compile(rf"\b{_NUM}\s*{_M}(?![a-z])")
_PLAIN = re.compile(rf"^{_NUM}$")
_WORDS = (("half an hour", 0.5), ("half hour", 0.5), ("an hour", 1.0), ("quarter of an hour", 0.25))

_RELATIVE_DAYS = {"today": 0, "yesterday": -1, "tomorrow": 1}
_WEEKDAYS = {
	name: index
	for index, names in enumerate(
		(
			("monday", "mon"),
			("tuesday", "tue", "tues"),
			("wednesday", "wed"),
			("thursday", "thu", "thur", "thurs"),
			("friday", "fri"),
			("saturday", "sat"),
			("sunday", "sun"),
		)
	)
	for name in names
}
_WEEKDAY_ALT = "|".join(sorted(_WEEKDAYS, key=len, reverse=True))
_RELATIVE_RE = re.compile(r"\b(today|yesterday|tomorrow)\b")
_WEEKDAY_RE = re.compile(rf"\b(?:(last|next|this)\s+)?({_WEEKDAY_ALT})\b")
_DAYS_AGO_RE = re.compile(r"\b(\d{1,3})\s+days?\s+ago\b")
_IN_DAYS_RE = re.compile(r"\bin\s+(\d{1,3})\s+days?\b")
_END_OF_RE = re.compile(r"\bend of (?:the |this )?(next )?(week|month|quarter|year)\b")
_NEXT_PERIOD_RE = re.compile(r"\bnext (week|month)\b")


def _valid_hours(hours: float | None) -> float | None:
	if hours is None or not 0 < hours <= 24:
		return None
	return round(hours, 2)


def _scan_hours(text: str) -> float | None:
	if match := _H_AND_M.search(text):
		return float(match.group(1)) + int(match.group(2)) / 60
	if match := _H_ONLY.search(text):
		return float(match.group(1))
	if match := _M_ONLY.search(text):
		return float(match.group(1)) / 60
	for phrase, hours in _WORDS:
		if phrase in text:
			return hours
	return None


def parse_hours(value: Any) -> float | None:
	"""Turn a model/user supplied duration into hours: 2, "2.5", "90 min", "1h30", "1:30".

	Returns None for anything that is not a sensible duration (0 < hours <= 24).
	"""
	if value is None or isinstance(value, bool):
		return None
	if isinstance(value, int | float):
		return _valid_hours(float(value))

	text = str(value).strip().lower().replace(",", ".")
	if not text:
		return None
	if match := _CLOCK.match(text):
		return _valid_hours(int(match.group(1)) + int(match.group(2)) / 60)
	if match := _PLAIN.match(text):
		return _valid_hours(float(match.group(1)))
	return _valid_hours(_scan_hours(text))


def find_hours(text: str) -> float | None:
	"""Find an explicit duration ("2h", "90 minutes") anywhere in a sentence. A bare number does not count."""
	return _valid_hours(_scan_hours((text or "").lower()))


def _weekday_date(qualifier: str | None, name: str, today: date, prefer: str) -> date:
	"""The date of a weekday name. "last X" is strictly before today and "next X" strictly after.
	A bare "X" is today if it is that weekday, otherwise the closest one in the `prefer` direction."""
	target = _WEEKDAYS[name]
	back = (today.weekday() - target) % 7
	forward = (target - today.weekday()) % 7
	if qualifier == "last":
		return today - timedelta(days=back or 7)
	if qualifier == "next":
		return today + timedelta(days=forward or 7)
	return today - timedelta(days=back) if prefer == "past" else today + timedelta(days=forward)


def _end_of(period: str, following: bool, today: date) -> date:
	if period == "week":  # the working week ends on Friday
		return _weekday_date(None, "friday", today + timedelta(days=7 if following else 0), "future")
	if period == "month":
		month = today.month + (1 if following else 0)
		year = today.year + (month - 1) // 12
		month = (month - 1) % 12 + 1
		return date(year + (month == 12), month % 12 + 1, 1) - timedelta(days=1)
	if period == "quarter":
		last_month = (today.month - 1) // 3 * 3 + 3 + (3 if following else 0)
		year = today.year + (last_month - 1) // 12
		last_month = (last_month - 1) % 12 + 1
		return date(year + (last_month == 12), last_month % 12 + 1, 1) - timedelta(days=1)
	return date(today.year + (1 if following else 0), 12, 31)


def find_date(text: str, today: date, prefer: str = "past") -> date | None:
	"""Find a relative date phrase in a sentence and resolve it in code, because a language model
	is unreliable at weekday arithmetic. Understands today/yesterday/tomorrow, "3 days ago",
	"in 2 days", "friday", "last friday", "next friday".

	`prefer` says which way a bare weekday points: "past" for things already done (time logs),
	"future" for things still to do (task due dates).
	"""
	text = (text or "").lower()
	if match := _RELATIVE_RE.search(text):
		return today + timedelta(days=_RELATIVE_DAYS[match.group(1)])
	if match := _DAYS_AGO_RE.search(text):
		return today - timedelta(days=int(match.group(1)))
	if match := _IN_DAYS_RE.search(text):
		return today + timedelta(days=int(match.group(1)))
	if match := _END_OF_RE.search(text):
		return _end_of(match.group(2), bool(match.group(1)), today)
	if match := _NEXT_PERIOD_RE.search(text):
		if match.group(1) == "week":
			return today + timedelta(days=7 - today.weekday())  # next Monday
		return _end_of("month", False, today) + timedelta(days=1)  # the 1st of next month
	if match := _WEEKDAY_RE.search(text):
		return _weekday_date(match.group(1), match.group(2), today, prefer)
	return None


def parse_date(value: Any, today: date, prefer: str = "past") -> date | None:
	"""Turn a model/user supplied date into a date: relative phrases, ISO strings, "Sep 12"."""
	if isinstance(value, datetime):
		return value.date()
	if isinstance(value, date):
		return value
	text = str(value or "").strip().lower()
	if not text:
		return None
	if found := find_date(text, today, prefer):
		return found
	try:
		return date.fromisoformat(text[:10])
	except ValueError:
		pass
	try:
		parsed = dateparser.parse(text, default=datetime(today.year, today.month, today.day)).date()
	except (ValueError, OverflowError):
		return None
	if prefer == "past" and parsed > today and str(today.year) not in text:
		parsed = parsed.replace(year=parsed.year - 1)  # "Dec 20" said in September means last December
	return parsed


def format_date(day: date | str) -> str:
	return getdate(day).strftime("%a %d %b %Y")


def format_hours(hours: float) -> str:
	return f"{hours:g} h"


def clean_text(value: Any, max_length: int = 500) -> str | None:
	"""Trim, drop control characters, cap the length. None when nothing is left."""
	if value is None or isinstance(value, bool | dict | list):
		return None
	text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", str(value)).strip()
	return text[:max_length] or None


_AMOUNT = re.compile(r"^\$?\s*(\d+(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|mm|thousand|million|grand)?$")
_AMOUNT_IN_TEXT = re.compile(
	r"(?:\$\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|thousand|million)?|\b\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|thousand|million|grand)\b)",
	re.IGNORECASE,
)
_MULTIPLIER = {"k": 1e3, "thousand": 1e3, "grand": 1e3, "m": 1e6, "mm": 1e6, "million": 1e6}


def parse_amount(value: Any) -> float | None:
	"""Turn "20k", "$1.5m", "20,000" or a number into an amount. None when it is not a sensible one."""
	if value is None or isinstance(value, bool):
		return None
	if isinstance(value, int | float):
		amount = float(value)
	else:
		match = _AMOUNT.match(str(value).strip().lower())
		if not match:
			return None
		amount = float(match.group(1).replace(",", "")) * _MULTIPLIER.get(match.group(2) or "", 1)
	return round(amount, 2) if 0 < amount < 1e12 else None


def find_amount(text: str) -> float | None:
	"""Find a money amount in a sentence. It needs a $ sign or a k/m suffix, so "2 hours" is not money."""
	if match := _AMOUNT_IN_TEXT.search((text or "").lower()):
		return parse_amount(match.group(0).replace(" ", ""))
	return None
