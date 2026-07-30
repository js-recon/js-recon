#!/bin/sh
set -e

# The container starts as root so a bind-mounted output directory (which inherits
# whatever ownership it had on the host, or the ownership Docker/Kubernetes assigns
# when creating it) can be made writable by pptruser regardless of who created it.
# If the container was forced to run as a non-root user already (e.g. a Kubernetes
# securityContext), this is a no-op and the mounted directory must already be
# writable by that user.
if [ "$(id -u)" = "0" ]; then
    mkdir -p /home/pptruser/output
    chown -R pptruser:pptruser /home/pptruser/output
    exec gosu pptruser "$@"
fi

exec "$@"
