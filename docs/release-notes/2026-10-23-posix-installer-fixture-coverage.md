# POSIX installer fixture coverage

The parity matrix records that the macOS and Linux CI jobs run POSIX installer fixture lifecycles for all seven runtimes outside the required `test-node` aggregate. Neither job uses `continue-on-error`, so a failure makes the workflow run fail. These fixtures do not verify live macOS CLI or hook behavior; that behavior remains unverified and deferred.
