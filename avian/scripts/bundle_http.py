#!/usr/bin/env python3
"""Fail-closed HTTP transport for every credential-bearing bundle client."""
from __future__ import annotations

import urllib.error
import urllib.request


class RejectAllRedirects(urllib.request.HTTPRedirectHandler):
    """Never replay a credential-bearing request at a redirected URL."""

    def redirect_request(self, request, response, code, message, headers, new_url):
        raise urllib.error.HTTPError(
            request.full_url, code, "credential-bearing redirects are forbidden", headers, response
        )


_OPENER = urllib.request.build_opener(RejectAllRedirects())


def urlopen(request: urllib.request.Request, timeout: int):
    """Open an exact endpoint without following any HTTP redirect."""
    return _OPENER.open(request, timeout=timeout)
