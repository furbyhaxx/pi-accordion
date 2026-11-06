# Working rules for this repository

- Run the tests with `python3 -m pytest -q`; they must pass before you finish.
- Every number that configures the limiter lives in `limiter/config.py`. Never hard-code a
  limit, window or multiplier anywhere else; import it from `limiter.config`.
- Never modify anything under `vendor/`; it is generated from the upstream schema.
- Every public function and class needs a docstring.
- Use only the Python standard library.
    