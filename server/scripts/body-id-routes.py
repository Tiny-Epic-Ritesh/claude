"""Every route that takes a record id in the body, and whether it checks it.

An id in the path is checked far more often than an id in the body: two of the
three found so far — /partners/:id/sourced-leads and /tickets/:id/merge — joined
records across the book. This asks the question of all of them.
"""
import re
from pathlib import Path

ROUTE = re.compile(r"router\.(get|post|patch|put|delete)\(\s*'([^']+)'")
# an id-shaped field taken off the body
BODY_ID = re.compile(r"""(?:
      req\.body\.([a-z_]*_id|[a-z]+Id)          # req.body.lead_id
    | \{[^}]*?\b([a-z_]*_id|[a-z]+Id)\b[^}]*?\}\s*=\s*req\.body   # { lead_id } = req.body
)""", re.X)

# signals the handler establishes what that id may reach
GUARD = re.compile(
    r'loadInBook|reqScope|reqClientScope|reqTicketScope|loadPartner|mayUseOrg|'
    r'orgsFor|sales_org\s*=\s*\?|AND sales_org|mayReadList|mayWriteList|scope\.sql',
)

routes = []
for f in sorted(Path('src/routes').glob('*.js')):
    text = f.read_text(encoding='utf-8', errors='ignore')
    lines = text.split('\n')
    starts = [(i, m) for i, ln in enumerate(lines) for m in [ROUTE.search(ln)] if m]
    for idx, (i, m) in enumerate(starts):
        end = starts[idx + 1][0] if idx + 1 < len(starts) else len(lines)
        body = '\n'.join(lines[i:end])
        ids = set()
        for mm in BODY_ID.finditer(body):
            ids.add(mm.group(1) or mm.group(2))
        # ignore ids that are merely echoed back or are not record references
        ids -= {'user_id'}
        if not ids:
            continue
        routes.append({
            'file': f.name,
            'verb': m.group(1).upper(),
            'path': m.group(2),
            'ids': sorted(ids),
            'guarded': bool(GUARD.search(body)),
            'line': i + 1,
        })

print(f'  {len(routes)} routes take a record id in the body\n')
unguarded = [r for r in routes if not r['guarded']]
guarded = [r for r in routes if r['guarded']]

print(f'  --- no scope helper in the handler ({len(unguarded)}) ---')
for r in unguarded:
    print(f"    {r['verb']:<6} {r['path']:<34} {r['file']:<18} {', '.join(r['ids'])}")

print(f'\n  --- consults one ({len(guarded)}), still worth reading ---')
for r in guarded:
    print(f"    {r['verb']:<6} {r['path']:<34} {r['file']:<18} {', '.join(r['ids'])}")
