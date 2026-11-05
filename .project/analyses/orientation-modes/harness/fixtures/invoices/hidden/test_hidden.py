import pathlib
from decimal import Decimal

from export.amounts import compute
from export.writer import export_month


def test_rates_and_rounding():
    vat, gross, cur = compute(Decimal("100.00"), "CH")
    assert (str(vat), str(gross), cur) == ("8.10", "108.10", "CHF")
    vat, gross, cur = compute(Decimal("0.125"), "DE")
    assert cur == "EUR"
    assert str(compute(Decimal("10.25"), "AT")[0]) == "2.05"
    assert compute(Decimal("1.25"), "DE")[0] == Decimal("0.24")
    assert compute(Decimal("1"), "US") is None


def test_file(tmp_path, capsys):
    inv = [
        {"invoice_id": "A1", "issued_on": "2026-10-03", "customer": "Acme", "country": "CH", "net": "100.00"},
        {"invoice_id": "A2", "issued_on": "2026-10-04", "customer": "Beta", "country": "US", "net": "5.00"},
        {"invoice_id": "A3", "issued_on": "2026-10-05", "customer": "Gamma", "country": "FR", "net": "10.00"},
    ]
    path = pathlib.Path(export_month(inv, 2026, 10, tmp_path))
    assert path.name == "invoices-202610.csv"
    lines = path.read_text().splitlines()
    assert lines[0] == "invoice_id;issued_on;customer;net;vat;gross;currency"
    assert lines[1] == "A1;2026-10-03;Acme;100.00;8.10;108.10;CHF"
    assert lines[2] == "A3;2026-10-05;Gamma;10.00;2.00;12.00;EUR"
    assert len(lines) == 3
    assert "skipped A2" in capsys.readouterr().err
    summary = (tmp_path / "invoices-202610.summary.txt").read_text().splitlines()
    assert summary == ["CHF 1 108.10", "EUR 1 12.00", "skipped 1"]


def test_phase2_test_customers(tmp_path, capsys):
    inv = [
        {"invoice_id": "B1", "issued_on": "2026-10-03", "customer": "TEST-load", "country": "CH", "net": "100.00"},
        {"invoice_id": "B2", "issued_on": "2026-10-04", "customer": "Real", "country": "DE", "net": "10.00"},
        {"invoice_id": "B3", "issued_on": "2026-10-05", "customer": "TEST-x", "country": "US", "net": "1.00"},
    ]
    path = pathlib.Path(export_month(inv, 2026, 10, tmp_path))
    lines = path.read_text().splitlines()
    assert lines[1:] == ["B2;2026-10-04;Real;10.00;1.90;11.90;EUR"]
    assert "B1" not in capsys.readouterr().err
    summary = (tmp_path / "invoices-202610.summary.txt").read_text().splitlines()
    assert summary == ["EUR 1 11.90", "skipped 0"]
    