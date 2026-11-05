# Plan

1. Put every limit from the spec into `limiter/config.py` (burst, refill time, gold multiplier).
2. Implement `TokenBucket` in `limiter/bucket.py` (refill based on elapsed time, injectable clock).
3. Implement `make_key` and `check_request` in `limiter/middleware.py` (allowed path only).
4. Add the rejection path: status, body with `retry_after_ms`, header, and the rejection log.
5. Extend `tests/` so every spec rule is covered, and run the whole suite.
    