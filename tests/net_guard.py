"""Imported by every test module: refuse any socket that isn't localhost, so a
test that forgets to mock the chain or GridStatus fails at once instead of
quietly reaching the network (audit finding S10).

It patches socket.create_connection, socket.socket.connect and
socket.getaddrinfo for the whole test process. Importing it twice is harmless.
"""

import socket

_LOCAL = {"localhost", "127.0.0.1", "::1", ""}


class NetworkBlocked(ConnectionRefusedError):
    """A test tried to reach the network."""


def _host(address):
    if isinstance(address, tuple) and address:
        return str(address[0])
    if isinstance(address, (str, bytes)):  # AF_UNIX paths
        return ""
    return str(address)


def _check(host):
    if host not in _LOCAL:
        raise NetworkBlocked(f"tests may not reach the network (tried {host!r}); mock it")


if not getattr(socket, "_gridflex_net_guard", False):
    _real_create_connection = socket.create_connection
    _real_connect = socket.socket.connect
    _real_connect_ex = socket.socket.connect_ex
    _real_getaddrinfo = socket.getaddrinfo

    def create_connection(address, *args, **kwargs):
        _check(_host(address))
        return _real_create_connection(address, *args, **kwargs)

    def connect(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            _check(_host(address))
        return _real_connect(self, address)

    def connect_ex(self, address):
        if self.family in (socket.AF_INET, socket.AF_INET6):
            _check(_host(address))
        return _real_connect_ex(self, address)

    def getaddrinfo(host, *args, **kwargs):
        _check("" if host is None else (host.decode() if isinstance(host, bytes) else str(host)))
        return _real_getaddrinfo(host, *args, **kwargs)

    socket.create_connection = create_connection
    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.getaddrinfo = getaddrinfo
    socket._gridflex_net_guard = True
