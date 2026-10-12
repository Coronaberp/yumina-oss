# Temporary card editing locks

An owner can use **Lock card** or **Unlock card** in Library → My Projects or the card detail panel. A locked card stays playable. Its editor, Studio changes, version restores, authored metadata and world assets cannot be changed through the API. Locked projects are excluded from bulk deletion.

The lock is stored in `worlds.editing_locked`, independently of `allow_edit` (the existing permission to make copies). It is outside the authored schema, so changing the lock does not change story content or propagate the lock into a new copy.

The owner-only control is `PATCH /api/worlds/:id/editing-lock` with `{ "locked": true }` or `{ "locked": false }`. Mutations rejected by a lock return HTTP 403 with `code: "WORLD_EDIT_LOCKED"`. The editor and Studio routes display the locked state rather than opening authoring controls.

`YUMINA_LOCKED_WORLD_IDS` optionally specifies comma-separated operator locks. These override the owner control until the IDs are removed from the environment and the service restarts. This is useful for immediate protection during deployment. Ordinary owner controls persist in the database and survive restarts.
