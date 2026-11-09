client_max_body_size 64k;
client_body_timeout 10s;
client_header_timeout 10s;
send_timeout 15s;
keepalive_timeout 15s;
limit_req zone=perip burst=20 nodelay;
limit_conn connperip 20;
server_tokens off;
proxy_connect_timeout 5s;
proxy_read_timeout 20s;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;   # the real caller once real_ip (below) has applied
# Per-source limits must count the visitor, not Railway's edge. Take the caller's address from the
# forwarded header, but only when the connection comes from a private/shared range an edge would use
# (Railway private network fd12::/16, CGNAT 100.64.0.0/10, RFC1918). A direct caller outside those
# ranges cannot spoof it. UNVERIFIED: on the first deploy check which header and range Railway really
# uses (X-Forwarded-For vs X-Real-IP) and tighten; if the range is wrong this degrades to one bucket
# for everyone (safe, not spoofable), never to a trusted spoofed address.
set_real_ip_from 100.64.0.0/10;
set_real_ip_from 10.0.0.0/8;
set_real_ip_from 172.16.0.0/12;
set_real_ip_from 192.168.0.0/16;
set_real_ip_from fd00::/8;
real_ip_header X-Forwarded-For;
real_ip_recursive on;
# Content-blind: allowed paths log nothing (no request line, no query string). Refusal locations
# turn on the 'refusal' format for themselves.
access_log off;
