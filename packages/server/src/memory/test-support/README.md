These integration helpers create a fresh in-memory PGlite database, scoped repositories, and fake model and embedding providers. The tests use real reconciliation, lore updates, secret reveals, clustering, transaction rollback, leases, snapshots, forks, and profile migration. They never contact a provider or the application database.

Regenerate the rendered recall fixture with:

```sh
python packages/server/src/memory/test-support/generate-service-golden.py /path/to/storyhaven-checkout
```

The generator reads the pinned commit with `git show`. It removes imports and executes only the pure configuration, ranking, and block modules in an isolated namespace. The fixture records their SHA-256 hashes. Synthetic facts mirror the deterministic successful provider responses in the integration scenario; expected text and memory ordering come from the original Python functions.
