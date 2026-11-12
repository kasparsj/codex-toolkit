# VAL-LOCAL-INDEX: Safe source-derived dashboard projection

Surface: RPC/data.
Needs: Retained run/draft sources and planted secrets.
Behavior: Return bounded allowlisted metadata only, validate registered root/repo/run and source modes, distinguish corrupt/removed source; derived index loss/rebuild restores current allowed view without touching journal/grants or dispatch; draftbody/credential/protected paths excluded.
Evidence: RPC projection traversal/symlink/corruption/source-removal/rebuild and sentinel tests with zero GitHub/dispatch requests on read.
