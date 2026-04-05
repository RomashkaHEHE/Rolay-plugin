# Rolay Auth, Roles, And User Management

This document captures the auth and user-management model that the plugin now targets.

## Current Model

- There is no public self-registration.
- Users include both `isAdmin` and `globalRole`.
- Global roles are `admin`, `writer`, `reader`.
- `writer` and `admin` can create rooms.
- `reader` can only join rooms.
- Every user can fetch their own profile and update only their own `displayName`.
- Every authenticated user can change their own password by proving knowledge of the current password.
- Admins can list users, create managed accounts, and delete managed accounts.

## Endpoints The Plugin Uses

### Session bootstrap

- `POST /v1/auth/login`
- `POST /v1/auth/refresh`
- `GET /v1/auth/me`

`login` returns tokens plus the current `user`. `refresh` only rotates tokens, so the plugin follows it with `GET /v1/auth/me` to rebuild authoritative user state including `isAdmin` and `globalRole`.

### Self-service profile update

- `PATCH /v1/auth/me/profile`

Request body:

```json
{
  "displayName": "Student One"
}
```

The plugin updates local session state immediately after a successful response.

### Self-service password change

- `PATCH /v1/auth/me/password`

Request body:

```json
{
  "currentPassword": "old-password",
  "newPassword": "new-password"
}
```

Successful responses rotate the active session and return a fresh `accessToken`, `refreshToken`, and `user`.

Plugin behavior:

- the settings UI asks for current password, new password, and confirmation
- after success, the plugin replaces the stored session tokens immediately
- the saved login password in plugin settings is also replaced with the new value
- the user is not required to do a separate logout/login roundtrip
- `password_unchanged` and wrong-current-password cases are surfaced directly in the UI

### Admin-managed account lifecycle

- `GET /v1/admin/users`
- `POST /v1/admin/users`
- `DELETE /v1/admin/users/{userId}`

Account creation request:

```json
{
  "username": "student1",
  "password": "temporary-password",
  "displayName": "Student One",
  "globalRole": "reader"
}
```

`displayName` is optional. `globalRole` for managed accounts currently supports `writer` and `reader`.

## Plugin UX Implications

- The settings UI always shows the current login, display name, global role, and admin flag.
- The plugin stores both `user.isAdmin` and `user.globalRole` in local session state.
- Admin-only sections are gated by `currentUser.isAdmin === true`.
- Room-creation UI is gated by `currentUser.globalRole` / `currentUser.isAdmin`, not by room membership.
- Public sign-up, password reset, and broader role-management workflows are intentionally out of scope for this repository right now.
