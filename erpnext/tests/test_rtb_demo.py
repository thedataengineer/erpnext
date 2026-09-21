# Copyright (c) 2026, Frappe Technologies Pvt. Ltd. and contributors
# For license information, please see license.txt

"""The Yadavilli Solutions demo seeder (see erpnext/setup/rtb_demo.py). It is proven by running it on a site
(`dry_run` rolls everything back); these checks are the parts that need no site data."""

import unittest
from unittest.mock import patch

from erpnext.setup import rtb_demo


class TestRtbDemo(unittest.TestCase):
	def test_running_it_again_changes_nothing(self):
		with patch.object(rtb_demo.frappe.db, "exists", return_value=True) as exists:
			with patch.object(rtb_demo.frappe.db, "savepoint") as savepoint:
				self.assertEqual(rtb_demo.create_yadavilli_solutions(), {})
		exists.assert_called_once_with("Company", "Yadavilli Solutions")
		savepoint.assert_not_called()

	def test_every_address_is_on_example_com(self):
		"""example.com can never be delivered to, so a demo contact can never receive real mail."""
		import inspect

		source = inspect.getsource(rtb_demo)
		self.assertNotIn("yadavilli.com", source.replace("Yadavilli Solutions", ""))
		self.assertIn('"example.com"', source)
		self.assertIn(".example.com", source)

	def test_no_rfq_supplier_is_set_to_receive_mail(self):
		import inspect

		source = inspect.getsource(rtb_demo.create_buying)
		self.assertNotIn('"send_email": 1', source)
		self.assertEqual(source.count('"send_email": 0'), 2)

	def test_the_credit_limit_leaves_room_for_the_orders(self):
		"""Bluebird owes 56 hours and has 5,760 on order: under its limit, or ERPNext would refuse the order."""
		limit = next(row[2] for row in rtb_demo.CUSTOMERS if row[0] == "Bluebird Analytics")
		owed, on_order = 56 * 150, 4 * 1300 + 4 * 140
		self.assertLess(owed + on_order, limit)
		self.assertGreater((owed + on_order) / limit, 0.8)
