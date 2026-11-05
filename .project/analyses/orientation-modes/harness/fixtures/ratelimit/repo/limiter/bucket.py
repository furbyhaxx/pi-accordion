"""Token bucket."""


class TokenBucket:
    """A token bucket. To be implemented (see docs/plan.md)."""

    def __init__(self, burst, refill_ms, clock=None):
        """`clock` is a zero-argument callable returning seconds (default `time.monotonic`)."""
        raise NotImplementedError

    def take(self):
        """Take one token; return the tokens left, or -1 when empty."""
        raise NotImplementedError
    