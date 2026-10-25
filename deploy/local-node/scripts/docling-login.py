#!/usr/bin/env python3
"""Wake Docling and print a one-use browser URL without revealing the LARM token."""
import importlib.util
import json
import urllib.request
from pathlib import Path


def main():
    spec = importlib.util.spec_from_file_location('hosting', Path(__file__).with_name('install-excalidraw-hosting.py'))
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    token = helpers.hosted_api_token('/etc/larm/larm.env')
    base = 'http://127.0.0.1:28765'
    request = urllib.request.Request(base + '/auth/ui-tickets', data=b'', method='POST',
                                     headers={'Authorization': 'Bearer ' + token})
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args):
            return None
    with urllib.request.build_opener(NoRedirect).open(request, timeout=190) as response:
        value = json.loads(response.read(8192))
    if not isinstance(value.get('url'), str) or not value['url'].startswith('/auth/exchange?'):
        raise RuntimeError('invalid_login_response')
    print(base + value['url'])


if __name__ == '__main__':
    main()
