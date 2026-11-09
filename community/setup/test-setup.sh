#!/usr/bin/env bash
# Stand-in test for setup.sh against a local fake of Railway's API. Checks: stops on a second project, creates the
# right things once, a second run creates nothing, and no generated passphrase appears in any output line.
# Run: bash community/setup/test-setup.sh   (needs python3, jq, openssl, curl)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; W="$(mktemp -d)"; trap 'kill $SRV 2>/dev/null || true; rm -rf "$W"' EXIT
cat > "$W/fake.py" <<'PY'
import json, sys, http.server
extra = sys.argv[2] == "extra"
st = {"svc": {}, "vol": [], "vars": [], "dom": [], "n": 0}
def nid(): st["n"] += 1; return "id%d" % st["n"]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        if self.headers.get("Authorization") != "Bearer faketoken": self.send_response(401); self.end_headers(); return
        b = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        q, v = b["query"], b["variables"]; d = {}
        if q.startswith("query { projects"):
            ps = [{"node": {"id": "P", "name": "wpi-community", "environments": {"edges": [{"node": {"id": "E", "name": "production"}}]},
                   "services": {"edges": [{"node": {"id": i, "name": n}} for n, i in st["svc"].items()]}}}]
            if extra: ps.append({"node": {"id": "Q", "name": "other", "environments": {"edges": []}, "services": {"edges": []}}})
            d = {"projects": {"edges": ps}}
        elif "serviceCreate" in q: i = nid(); st["svc"][v["i"]["name"]] = i; d = {"serviceCreate": {"id": i}}
        elif "variableCollectionUpsert" in q: st["vars"].append(v["i"]); d = {"variableCollectionUpsert": True}
        elif "volumeCreate" in q: st["vol"].append((v["i"]["serviceId"], v["i"]["mountPath"])); d = {"volumeCreate": {"id": nid()}}
        elif "volumes" in q:
            d = {"project": {"volumes": {"edges": [{"node": {"volumeInstances": {"edges": [{"node": {"serviceId": s, "mountPath": m}} for s, m in st["vol"]]}}}]}}}
        elif "domains(" in q: d = {"domains": {"serviceDomains": [{"domain": x} for x in st["dom"]]}}
        elif "serviceDomainCreate" in q: st["dom"].append("x.up.railway.app"); d = {"serviceDomainCreate": {"domain": "x.up.railway.app"}}
        out = json.dumps({"data": d}).encode(); self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers(); self.wfile.write(out)
    def do_GET(self):
        out = json.dumps(st["vars"]).encode(); self.send_response(200); self.end_headers(); self.wfile.write(out)
s = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H); s.serve_forever()
PY
start() { python3 "$W/fake.py" "$1" "$2" & SRV=$!; sleep 1; }
export RAILWAY_SETUP_TOKEN=faketoken
# 1: a second project in the workspace stops the job before anything is created
start 18771 extra; export RAILWAY_API=http://127.0.0.1:18771
if bash "$HERE/setup.sh" >"$W/o0" 2>&1; then echo "FAIL: ran with a second project present"; exit 1; fi
grep -q 'must hold exactly one project' "$W/o0" || { echo "FAIL: wrong stop message"; cat "$W/o0"; exit 1; }
kill $SRV; wait $SRV 2>/dev/null || true
# 2: clean run, then a second run
start 18772 one; export RAILWAY_API=http://127.0.0.1:18772
bash "$HERE/setup.sh" >"$W/o1" 2>&1 || { cat "$W/o1"; echo "FAIL: first run"; exit 1; }
bash "$HERE/setup.sh" >"$W/o2" 2>&1 || { cat "$W/o2"; echo "FAIL: second run"; exit 1; }
curl -s "$RAILWAY_API" > "$W/state.json"
[ "$(jq length "$W/state.json")" = "5" ] || { echo "FAIL: expected 5 variable writes (Redis, mediator, proxy, 2 passphrases) once, got $(jq length "$W/state.json")"; exit 1; }
grep -q 'created this run: nothing' "$W/o2" || { echo "FAIL: second run created something"; cat "$W/o2"; exit 1; }
grep -q 'not yet sealed: VTA_SEED_PASSPHRASE VTC_SECRETS_PASSPHRASE' "$W/o1" || { echo "FAIL: no 'not yet sealed' line"; exit 1; }
# 3: no passphrase value in any output; a passphrase is long enough
for n in VTA_SEED_PASSPHRASE VTC_SECRETS_PASSPHRASE; do
  val=$(jq -r --arg n "$n" '.[].variables[$n] // empty' "$W/state.json")
  [ "${#val}" -ge 22 ] || { echo "FAIL: $n too short"; exit 1; }
  # the one allowed appearance is the `::add-mask::` line, which the Actions runner consumes (the value shows as ***)
  if grep -v '^::add-mask::' "$W"/o0 "$W"/o1 "$W"/o2 | grep -qF "$val"; then echo "FAIL: $n value printed"; exit 1; fi
  grep -qF "::add-mask::$val" "$W/o1" || { echo "FAIL: $n was not masked before use"; exit 1; }
done
[ "$(jq -r '.[0].variables.REDIS_URL' "$W/state.json")" != "null" ] && grep -q 'Redis.REDIS_URL' "$W/state.json" || { echo "FAIL: variables"; exit 1; }
if grep -q 'faketoken' "$W"/o0 "$W"/o1 "$W"/o2; then echo "FAIL: token printed"; exit 1; fi
echo "ok: setup.sh stops on a second project, creates once, second run creates nothing, nothing secret printed"
