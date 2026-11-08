"""validate_website_url accepts public website addresses only."""
import pytest
from django.core.exceptions import ValidationError

from core.validators.url_validator import validate_website_url


@pytest.mark.parametrize("url, expected", [
    ("example.com", "https://example.com"),
    ("https://www.outfi.ai", "https://www.outfi.ai"),
    ("http://shop.example.co.uk/path?q=1", "http://shop.example.co.uk/path?q=1"),
    ("https://example.com:8443", "https://example.com:8443"),
    ("münchen.de", "https://münchen.de"),
    ("xn--mnchen-3ya.de", "https://xn--mnchen-3ya.de"),
    ("http://8.8.8.8", "http://8.8.8.8"),
    ("example.com.", "https://example.com."),
])
def test_accepts_public_addresses(url, expected):
    assert validate_website_url(url) == expected


@pytest.mark.parametrize("url", [
    "not-a-url",          # no dot: not a public name
    "intranet",
    "https://intranet/",
    "https://example.123",  # numeric "TLD"
    "https://-bad.example.com",
    "https://exa_mple.com",
    "https://a..example.com",
    "https://example.com:99999",  # malformed port
])
def test_rejects_non_domains(url):
    with pytest.raises(ValidationError):
        validate_website_url(url)


@pytest.mark.parametrize("url", [
    "localhost",
    "http://localhost:8000",
    "http://127.0.0.1/admin",
    "http://10.0.0.5",
    "http://192.168.1.1",
    "http://172.16.0.1",
    "http://169.254.169.254/latest/meta-data",  # link-local metadata address
    "http://[::1]/",
    "http://0.0.0.0",
    "http://user@localhost/",  # userinfo does not hide the host
])
def test_rejects_private_hosts(url):
    with pytest.raises(ValidationError, match="publicly reachable"):
        validate_website_url(url)


def test_rejects_empty():
    with pytest.raises(ValidationError):
        validate_website_url("")
