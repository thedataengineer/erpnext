# One product from several apps

RTB core is one module of a product that also has Hubble (`hrms`), Learning (`lms`), Frappe Suite
(`suite`), Raven (`raven`) and Payments on the same site. The contract that every module is integrable at
the code, database and solution level, the measured numbers and the test that proves it
(`rtb/tests/test_stack_integration.py`) live with the product that composes them:
https://github.com/thedataengineer/rtb-erp, in `docs/stack_integration.md` there.

What RTB core promises on its own is what its own tests check: the assistant answers HR questions and
the Focus inbox takes Hubble's rows when Hubble is installed, and each degrades to a plain sentence when
it is not.
