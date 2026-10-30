# Task runtime

Shared execution services live here. This package imports no applications and
reads no buddy configuration. Hosts provision trusted policy sources and execution
resources; tasks receive only the capabilities they need.

Trusted project settings are read from an immutable commit and bound to their
source repository. Candidate checkouts never activate their own policy.
Compatibility exports in the issue pipeline keep existing callers operational
while the host translates its configuration into explicit service inputs.
