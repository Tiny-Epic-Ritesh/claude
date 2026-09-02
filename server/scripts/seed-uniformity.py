"""Which entities sit entirely in one book?

A boundary cannot be tested against data that only exists on one side of it.
Two rows of missing data hid three live defects last time, so this asks the
question for every table that has a book — its own column, or one it inherits
from a parent.
"""
import sqlite3

c = sqlite3.connect('data/bonanza.db')
tables = [r[0] for r in c.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def cols(t):
    return [r[1] for r in c.execute(f'PRAGMA table_info({t})')]


# How a table without its own sales_org inherits one.
VIA = {
    'lead_id': 'leads',
    'client_id': 'clients',
    'partner_id': 'partners',
    'ticket_id': 'tickets',
    'list_id': 'lead_lists',
}

own, derived, bookless = [], [], []

for t in tables:
    cs = cols(t)
    n = c.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
    if n == 0:
        continue
    if 'sales_org' in cs:
        dist = dict(c.execute(f'SELECT sales_org, COUNT(*) FROM {t} GROUP BY sales_org'))
        own.append((t, n, dist))
        continue
    parent = next(((k, v) for k, v in VIA.items() if k in cs), None)
    if parent:
        key, ptable = parent
        if 'sales_org' not in cols(ptable):
            continue
        dist = dict(c.execute(
            f'SELECT p.sales_org, COUNT(*) FROM {t} x JOIN {ptable} p ON p.id = x.{key} GROUP BY p.sales_org'))
        orphan = c.execute(f'SELECT COUNT(*) FROM {t} WHERE {key} IS NULL').fetchone()[0]
        derived.append((t, n, dist, key, orphan))
    else:
        bookless.append((t, n))


def verdict(dist):
    books = [k for k, v in dist.items() if v]
    if len(books) > 1:
        return 'both books'
    if len(books) == 1:
        return f'ONLY {books[0]}'
    return 'no book'


print('  tables with their own sales_org\n')
uniform_own = []
for t, n, dist in sorted(own):
    v = verdict(dist)
    flag = '  <-- uniform' if v.startswith('ONLY') else ''
    print(f'    {t:<26} {n:>5} rows   {str(dist):<34} {v}{flag}')
    if v.startswith('ONLY'):
        uniform_own.append(t)

print('\n  tables that inherit a book from a parent\n')
uniform_derived = []
for t, n, dist, key, orphan in sorted(derived):
    v = verdict(dist)
    flag = '  <-- uniform' if v.startswith('ONLY') else ''
    extra = f'  ({orphan} with no {key})' if orphan else ''
    print(f'    {t:<26} {n:>5} rows   via {key:<11} {str(dist):<26} {v}{flag}{extra}')
    if v.startswith('ONLY'):
        uniform_derived.append(t)

print('\n  ' + '-' * 70)
allu = uniform_own + uniform_derived
if allu:
    print(f'  {len(allu)} entit{"y" if len(allu) == 1 else "ies"} sit entirely in one book:')
    for t in allu:
        print(f'    {t}')
else:
    print('  every entity with a book has rows on both sides of it.')
