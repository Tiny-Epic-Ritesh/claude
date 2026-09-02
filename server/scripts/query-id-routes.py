"""Every route that takes a record id in the query string.

Different risk from a body id. A filter intersects with a scoped list, so an
out-of-book id should narrow it to nothing rather than leak. Two things break
that: an id used to LOAD rather than filter, and a response that distinguishes
"exists elsewhere" from "does not exist" — an existence oracle leaks by the
shape of the answer even when it returns no rows.
"""
import re
from pathlib import Path

ROUTE = re.compile(r"router\.(get|post|patch|put|delete)\(\s*'([^']+)'")
QUERY_ID = re.compile(r"""(?:
      req\.query\.([a-z_]*_id|[a-z]+Id)
    | \{[^}]*?\b([a-z_]*_id|[a-z]+Id)\b[^}]*?\}\s*=\s*req\.query
)""", re.X)

# does the id reach a WHERE that also carries the caller's scope?
SCOPED = re.compile(
    r'loadInBook|reqScope|reqClientScope|reqTicketScope|loadPartner|mayUseOrg|'
    r'orgsFor|scope\.sql|clientFilter|ticketFilter|partnerFilter|taskBase',
)

rows = []
for f in sorted(Path('src/routes').glob('*.js')):
    text = f.read_text(encoding='utf-8', errors='ignore')
    lines = text.split('\n')
    starts = [(i, m) for i, ln in enumerate(lines) for m in [ROUTE.search(ln)] if m]
    for idx, (i, m) in enumerate(starts):
        end = starts[idx + 1][0] if idx + 1 < len(starts) else len(lines)
        body = '\n'.join(lines[i:end])
        ids = set()
        for mm in QUERY_ID.finditer(body):
            ids.add(mm.group(1) or mm.group(2))
        ids -= {'user_id'}
        if not ids:
            continue
        rows.append({
            'file': f.name, 'verb': m.group(1).upper(), 'path': m.group(2),
            'ids': sorted(ids), 'scoped': bool(SCOPED.search(body)),
        })

print(f'  {len(rows)} routes take a record id in the query string\n')
for group, want in (('no scope helper in the handler', False), ('consults one', True)):
    sel = [r for r in rows if r['scoped'] is want]
    print(f'  --- {group} ({len(sel)}) ---')
    for r in sel:
        print(f"    {r['verb']:<6} {r['path']:<32} {r['file']:<18} {', '.join(r['ids'])}")
    print()
