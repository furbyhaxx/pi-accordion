# Working rules

- Money is always `decimal.Decimal`, never `float`; parse amounts with `Decimal(str)`.
- VAT rates and currencies live only in `export/rates.py`.
- Do not edit anything under `tests/fixtures/`; it mirrors production data.
- Run `python3 -m pytest -q` before you finish; it must pass.
- Standard library only.
    