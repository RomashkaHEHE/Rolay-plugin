# Rolay Room Model

Rolay now treats the room as the main collaboration object.

## Core Rules

- Room names are not unique.
- Stable identity is always `workspace.id`.
- The plugin must never key local state by room name.
- A user can belong to multiple rooms.
- Multiple downloaded rooms should be able to sync in parallel.

## Roles

There are two role layers:

1. Global user role
   `admin`, `writer`, `reader`
2. Room-local membership role
   `owner`, `member`

The plugin uses them differently:

- `user.globalRole` and `user.isAdmin` gate global UI such as room creation and admin sections.
- `room.membershipRole` gates room-local UI such as invite controls.

## Invite Lifecycle

Each room has one current invite key:

- enable/disable toggles whether it works
- enable/disable does not rotate the key
- regenerate rotates the key and invalidates the old one

Owner invite controls in the plugin are therefore scoped per room, not through a global active-room switch.

## Local Projection Strategy

Each room is bound to its own local folder name.

- Default folder name: room name
- `workspace.id` is not the standard folder name
- The user can change the folder name before download
- After download, the folder binding is treated as locked by the current MVP
- Download is rejected if the target folder already exists in the vault

The resulting local projection path is:

`syncRoot/<room-folder-name>/...`

This keeps local file paths stable even if:

- two rooms share the same human-readable name
- a user downloads several rooms at once
- room membership changes later and some local folders remain in the vault
