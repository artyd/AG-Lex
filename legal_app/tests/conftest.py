"""Shared pytest setup.

Most suites create their users through `POST /api/auth/register` with an
arbitrary role, which production refuses (`REGISTRATION_MODE=closed`, see
auth.py). Tests opt into the dev-only open mode before `backend.config` is
imported; `test_registration_gate.py` flips it back to exercise the gate.
"""
import os

os.environ.setdefault("REGISTRATION_MODE", "open")
# Suites log in as the seeded demo user; prod keeps it disabled (auth.login_blocked).
os.environ.setdefault("DEMO_LOGIN_ENABLED", "1")
