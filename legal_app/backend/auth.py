"""Authentication for AG Lex — bcrypt + JWT.

Phase 2.1. Three routes (`/api/auth/register`, `/login`, `/me`), one FastAPI
dependency (`current_user`), one startup seed (`seed_test_user`). Sessions are
stateless JWTs — no `sessions` table for the MVP; revocation can land later.

Security choices:
  - bcrypt direct (12 rounds, library default — slow enough that brute force
    is impractical, fast enough not to break login UX). Passlib was dropped
    after Phase 2.1: passlib 1.7.4 misreads bcrypt 4.x+'s `__about__` and
    falls through to a broken codepath. Calling the `bcrypt` module directly
    is the upstream-recommended workaround.
  - JWT HS256 signed with `settings.JWT_SECRET`. Payload: `sub` (user_id),
    `role`, `exp`. 24-hour TTL per Phase 2.1 doc.
  - Single endpoint surface returns generic "Invalid email or password" on
    login failure — no user-enumeration leak via timing or distinct messages.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

import bcrypt
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from pydantic import BaseModel, EmailStr, Field

from .config import get_settings
from .database import get_db


# ---------------------------------------------------------------------------
# constants
# ---------------------------------------------------------------------------

JWT_ALGORITHM = "HS256"
# Long TTL on purpose: this is an internal workspace tool, not a public web
# service. Pairing the long TTL with a rolling /api/auth/refresh call on every
# app open means a user who keeps using the app effectively never has to log in
# again, while we still get JWT signature verification on every request.
TOKEN_TTL_HOURS = 24 * 365
TEST_USER_EMAIL = "test@aglex.ua"
TEST_USER_PASSWORD = "test1234"  # nosec — demo seed, see Phase 2.1 doc
TEST_USER_NAME = "Тестовий Користувач"
TEST_USER_ROLE = "partner"

# Production-side seeded account for Вікторія Верещагіна (full partner access,
# but her personal data — AI chat sessions, contracts she uploads, calendar
# items she creates — starts empty so she lands on a clean state).
VIKTORIA_USER_EMAIL = "viktoria@aglex.ua"
VIKTORIA_USER_PASSWORD = "viktoria2026"  # nosec — handover credential, rotate after first login
VIKTORIA_USER_NAME = "Вікторія Верещагіна"
VIKTORIA_USER_ROLE = "partner"


Role = Literal["partner", "senior", "lawyer", "paralegal", "admin"]


# bcrypt has a hard 72-byte input limit. UTF-8 Cyrillic is 2 bytes/char, so a
# Pydantic `max_length=128` chars (chars, not bytes) can still overflow. We
# pre-truncate to 72 bytes here — standard upstream workaround.
_BCRYPT_MAX_BYTES = 72


# Used as the OpenAPI auth scheme + extracts `Authorization: Bearer <token>`.
# `tokenUrl` is informational; our login endpoint takes JSON, not form data.
_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


# ---------------------------------------------------------------------------
# pydantic models
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    email: EmailStr
    password: str = Field(..., min_length=8, max_length=128)
    role: Role = "lawyer"


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=128)


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: Role
    created_at: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ---------------------------------------------------------------------------
# password + JWT helpers
# ---------------------------------------------------------------------------

def _to_bcrypt_input(plain: str) -> bytes:
    """UTF-8 encode + truncate to bcrypt's 72-byte input limit."""
    return plain.encode("utf-8")[:_BCRYPT_MAX_BYTES]


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(_to_bcrypt_input(plain), bcrypt.gensalt()).decode("ascii")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(_to_bcrypt_input(plain), hashed.encode("ascii"))
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: int, role: str) -> str:
    settings = get_settings()
    now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": str(user_id),
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(hours=TOKEN_TTL_HOURS)).timestamp()),
    }
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    settings = get_settings()
    return jwt.decode(token, settings.JWT_SECRET, algorithms=[JWT_ALGORITHM])


# ---------------------------------------------------------------------------
# user repository (thin SQL over sqlite3)
# ---------------------------------------------------------------------------

_USER_COLUMNS = "id, email, name, role, password_hash, created_at"


def _row_to_user(row: tuple | None) -> dict | None:
    if row is None:
        return None
    return {
        "id": row[0],
        "email": row[1],
        "name": row[2],
        "role": row[3],
        "password_hash": row[4],
        "created_at": row[5],
    }


def get_user_by_email(conn: sqlite3.Connection, email: str) -> dict | None:
    row = conn.execute(
        f"SELECT {_USER_COLUMNS} FROM users WHERE email = ?",
        (email.lower(),),
    ).fetchone()
    return _row_to_user(row)


def get_user_by_id(conn: sqlite3.Connection, user_id: int) -> dict | None:
    row = conn.execute(
        f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    return _row_to_user(row)


def create_user(
    conn: sqlite3.Connection,
    *,
    email: str,
    name: str,
    role: str,
    password: str,
) -> dict:
    now = datetime.now(tz=timezone.utc).isoformat()
    try:
        cur = conn.execute(
            "INSERT INTO users (email, name, role, password_hash, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (email.lower(), name, role, hash_password(password), now),
        )
        conn.commit()
    except sqlite3.IntegrityError as e:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Email already registered.",
        ) from e
    new_id = cur.lastrowid
    assert new_id is not None  # sqlite3 sets lastrowid after a successful INSERT
    user = get_user_by_id(conn, new_id)
    assert user is not None  # row was just inserted in the same connection
    return user


def seed_test_user(conn: sqlite3.Connection) -> None:
    """Create the demo `test@aglex.ua` account if missing (Phase 2.1 step 3)."""
    if get_user_by_email(conn, TEST_USER_EMAIL):
        return
    create_user(
        conn,
        email=TEST_USER_EMAIL,
        name=TEST_USER_NAME,
        role=TEST_USER_ROLE,
        password=TEST_USER_PASSWORD,
    )


def seed_viktoria_user(conn: sqlite3.Connection) -> None:
    """Provision the `viktoria@aglex.ua` partner account if missing.

    Same role + capabilities as the test partner; the workspace data (matters,
    tasks, codex articles, etc.) is global so she sees the shared content, but
    her per-user state (AI chat sessions, uploaded contracts, calendar items
    she creates) starts empty. Idempotent — running on every boot is a no-op
    once the row exists.
    """
    if get_user_by_email(conn, VIKTORIA_USER_EMAIL):
        return
    create_user(
        conn,
        email=VIKTORIA_USER_EMAIL,
        name=VIKTORIA_USER_NAME,
        role=VIKTORIA_USER_ROLE,
        password=VIKTORIA_USER_PASSWORD,
    )


# ---------------------------------------------------------------------------
# current_user dependency
# ---------------------------------------------------------------------------

def _credentials_exception(detail: str = "Could not validate credentials") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def current_user(
    token: Optional[str] = Depends(_oauth2_scheme),
    conn: sqlite3.Connection = Depends(get_db),
) -> dict:
    """Resolve `Authorization: Bearer <token>` to a user row.

    Raises 401 for missing, malformed, expired, or "user-no-longer-exists"
    tokens. Drop this dep into any protected route: `Depends(current_user)`.
    """
    if not token:
        raise _credentials_exception("Missing bearer token")
    try:
        payload = decode_token(token)
    except JWTError as e:
        raise _credentials_exception(f"Invalid token: {e}") from e
    user_id_raw = payload.get("sub")
    if user_id_raw is None:
        raise _credentials_exception("Token missing subject")
    try:
        user_id = int(user_id_raw)
    except (TypeError, ValueError) as e:
        raise _credentials_exception("Invalid token subject") from e
    user = get_user_by_id(conn, user_id)
    if user is None:
        raise _credentials_exception("User no longer exists")
    return user


# ---------------------------------------------------------------------------
# router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _user_out(user: dict) -> UserOut:
    return UserOut(
        id=user["id"],
        email=user["email"],
        name=user["name"],
        role=user["role"],
        created_at=user["created_at"],
    )


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED)
def register(req: RegisterRequest, conn: sqlite3.Connection = Depends(get_db)) -> TokenResponse:
    user = create_user(
        conn,
        email=req.email,
        name=req.name.strip(),
        role=req.role,
        password=req.password,
    )
    token = create_access_token(user["id"], user["role"])
    return TokenResponse(access_token=token, user=_user_out(user))


@router.post("/login", response_model=TokenResponse)
def login(req: LoginRequest, conn: sqlite3.Connection = Depends(get_db)) -> TokenResponse:
    user = get_user_by_email(conn, req.email)
    # Same response for "no such user" and "wrong password" to avoid
    # user-enumeration via the response body or timing differences.
    if user is None or not verify_password(req.password, user["password_hash"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password.",
        )
    token = create_access_token(user["id"], user["role"])
    return TokenResponse(access_token=token, user=_user_out(user))


@router.get("/me", response_model=UserOut)
def me(user: dict = Depends(current_user)) -> UserOut:
    return _user_out(user)


@router.post("/refresh", response_model=TokenResponse)
def refresh(user: dict = Depends(current_user)) -> TokenResponse:
    """Mint a fresh token for the currently authenticated user.

    The FE calls this on app startup so the cached token's `exp` keeps
    rolling forward — as long as the user opens the app within the TTL, the
    session effectively never expires and no re-login is ever required.
    """
    token = create_access_token(user["id"], user["role"])
    return TokenResponse(access_token=token, user=_user_out(user))
