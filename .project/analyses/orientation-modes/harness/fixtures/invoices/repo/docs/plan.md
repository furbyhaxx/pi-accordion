# Plan

1. Put the rates and currencies into `export/rates.py`.
2. Implement `compute(net, country)` in `export/amounts.py` returning (vat, gross, currency).
3. Implement `export_month(invoices, year, month, outdir)` in `export/writer.py`, returning the CSV path.
4. Add the summary file to `export_month`.
5. Cover the spec with tests and run the suite.
    