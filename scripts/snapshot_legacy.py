"""Consistent snapshot of the live legacy SQLite DB.

Uses the SQLite Online Backup API (sqlite3.Connection.backup), which holds a
read lock for the duration and produces a transactionally consistent copy even
if the FastAPI process writes concurrently. Source is opened read-only.
"""
import sqlite3
import os

SRC = "file:/app/backend/data/posts.db?mode=ro"
DST = "/tmp/legacy_snapshot.db"

if os.path.exists(DST):
    os.remove(DST)

src = sqlite3.connect(SRC, uri=True)
dst = sqlite3.connect(DST)

with dst:
    src.backup(dst, pages=0)  # pages=0 -> copy everything in one atomic step

# Prove the snapshot is internally consistent before we trust it.
print("integrity_check:", dst.execute("pragma integrity_check").fetchone()[0])
print("foreign_key_check rows:", len(dst.execute("pragma foreign_key_check").fetchall()))

for (t,) in dst.execute(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
):
    n = dst.execute('select count(*) from "%s"' % t).fetchone()[0]
    print("%s\t%d" % (t, n))

src.close()
dst.close()
print("snapshot written:", DST, os.path.getsize(DST), "bytes")
