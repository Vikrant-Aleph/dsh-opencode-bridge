TEST ONLY - PUBLIC LOOPBACK FIXTURES, NOT SECRETS

Every certificate and private key in socks-tls-* is deliberately public test
material. NEVER trust this CA outside isolated tests or use these keys for
production, a user profile, or a real service. The helper binds only 127.0.0.1.
The origin certificate covers localhost, origin.socks.test and 127.0.0.1;
wrong.socks.test deliberately does not match. Tests pass this CA explicitly;
TLS verification is never disabled or changed globally.

Regenerate using OpenSSL with socks-tls-openssl.cnf: create a self-signed CA
with ca_ext, an origin CSR, then sign it with origin_ext. The CA private key
and CSR are retained solely to make fixture provenance reproducible. Long
validity prevents wall-clock expiration in this offline test suite.
