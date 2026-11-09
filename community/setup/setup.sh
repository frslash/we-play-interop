#!/usr/bin/env bash
# One-time Railway setup for the room's test host (project `wpi-community`). Run only by
# .github/workflows/setup-community.yml (manual dispatch, main only, environment `railway-setup`).
# Security's terms (blocks 10727, 10742, 10768, 10790): create-only and idempotent; the first call is a harmless
# read that stops on a permission error; stops if the workspace holds any project other than wpi-community;
# passphrases are made here, masked, never printed, never in a command line (they pass through files under a 0700 temp dir), never in a log; the job never deletes
# anything and never reads a secret back.
# Needs: RAILWAY_SETUP_TOKEN (workspace token). Optional: RAILWAY_API (tests only), GITHUB_ACTIONS.
set -euo pipefail
set +x
API="${RAILWAY_API:-https://backboard.railway.com/graphql/v2}"
PROJECT_NAME="wpi-community"
REDIS_IMAGE="redis:7.4.6-alpine@sha256:3b73847e72874be07e6657b129a94761662b79bc0f679273757d4218573b2a98"
: "${RAILWAY_SETUP_TOKEN:?RAILWAY_SETUP_TOKEN is missing: it must be a secret of the railway-setup environment}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT; chmod 700 "$T"

# gql <query> [variables-json]: POST, print the data object; fail loudly (never echo the token or variables).
gql() {
  local vars="${2:-}"; [ -n "$vars" ] || vars='{}'
  if [ "${vars:0:1}" = "@" ]; then   # variables come from a file (secrets: kept out of every command line)
    jq -n --arg q "$1" --slurpfile v "${vars:1}" '{query:$q,variables:$v[0]}' > "$T/req.json"
  else
    jq -n --arg q "$1" --argjson v "$vars" '{query:$q,variables:$v}' > "$T/req.json"
  fi
  local code
  code=$(curl -sS --proto '=https,http' -o "$T/res.json" -w '%{http_code}' --max-time 60 -X POST "$API" \
    -H "Authorization: Bearer ${RAILWAY_SETUP_TOKEN}" -H 'Content-Type: application/json' --data @"$T/req.json") || { echo "::error::Railway API unreachable"; exit 1; }
  rm -f "$T/req.json"
  if [ "$code" != "200" ]; then echo "::error::Railway API answered HTTP $code (a permission or token problem; nothing was created by this call)"; exit 1; fi
  if jq -e '.errors' "$T/res.json" >/dev/null; then echo "::error::Railway API error: $(jq -r '[.errors[].message]|join("; ")' "$T/res.json" | cut -c1-300)"; exit 1; fi
  jq -c '.data' "$T/res.json"
}

echo "step 1: harmless read (projects in this workspace)"
P=$(gql 'query { projects { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } }')
n=$(jq '.projects.edges|length' <<<"$P")
others=$(jq -r --arg n "$PROJECT_NAME" '[.projects.edges[].node.name | select(. != $n)] | length' <<<"$P")
if [ "$others" != "0" ] || [ "$n" != "1" ]; then
  echo "::error::this token's workspace must hold exactly one project, $PROJECT_NAME; it holds $n ($others other). Stopping; nothing created."; exit 1
fi
PID=$(jq -r '.projects.edges[0].node.id' <<<"$P")
EID=$(jq -r '.projects.edges[0].node.environments.edges[] | select(.node.name=="production") | .node.id' <<<"$P")
[ -n "$EID" ] || { echo "::error::no 'production' environment in $PROJECT_NAME"; exit 1; }
echo "project and environment found; services present: $(jq -r '[.projects.edges[0].node.services.edges[].node.name]|join(",")' <<<"$P")"

declare -A SID
for s in $(jq -r '.projects.edges[0].node.services.edges[].node | "\(.name)=\(.id)"' <<<"$P"); do SID[${s%%=*}]=${s#*=}; done
CREATED=""

ensure_service() { # name [image]
  local name="$1" image="${2:-}" r
  if [ -n "${SID[$name]:-}" ]; then echo "service $name exists, left alone"; return; fi
  if [ -n "$image" ]; then
    r=$(gql 'mutation($i: ServiceCreateInput!){ serviceCreate(input:$i){ id } }' "$(jq -nc --arg p "$PID" --arg e "$EID" --arg n "$name" --arg img "$image" '{i:{projectId:$p,environmentId:$e,name:$n,source:{image:$img}}}')")
  else
    r=$(gql 'mutation($i: ServiceCreateInput!){ serviceCreate(input:$i){ id } }' "$(jq -nc --arg p "$PID" --arg e "$EID" --arg n "$name" '{i:{projectId:$p,environmentId:$e,name:$n}}')")
  fi
  SID[$name]=$(jq -r '.serviceCreate.id' <<<"$r"); CREATED="$CREATED $name"; echo "service $name created"
}

set_vars() { # service  name=value ...   (values never echoed, never in any command line: they pass through files under the 0700 temp dir)
  local svc="$1"; shift
  local kv
  printf '{}' > "$T/obj.json"
  for kv in "$@"; do
    printf '%s' "${kv#*=}" > "$T/val"
    jq -c --arg k "${kv%%=*}" --rawfile v "$T/val" '. + {($k):$v}' "$T/obj.json" > "$T/obj2.json" && mv "$T/obj2.json" "$T/obj.json"
  done
  jq -n --arg p "$PID" --arg e "$EID" --arg s "${SID[$svc]}" --slurpfile v "$T/obj.json" '{i:{projectId:$p,environmentId:$e,serviceId:$s,variables:$v[0],skipDeploys:true}}' > "$T/in.json"
  gql 'mutation($i: VariableCollectionUpsertInput!){ variableCollectionUpsert(input:$i) }' "@$T/in.json" >/dev/null
  rm -f "$T/val" "$T/obj.json" "$T/in.json"
  echo "variables set on $svc: $(for kv in "$@"; do printf '%s ' "${kv%%=*}"; done)"
}

ensure_volume() { # service mountPath
  local svc="$1" path="$2" have
  have=$(gql 'query($p:String!){ project(id:$p){ volumes { edges { node { volumeInstances { edges { node { serviceId mountPath } } } } } } } }' "$(jq -nc --arg p "$PID" '{p:$p}')" \
    | jq -r --arg s "${SID[$svc]}" --arg m "$path" '[.project.volumes.edges[].node.volumeInstances.edges[].node | select(.serviceId==$s and .mountPath==$m)]|length')
  if [ "$have" != "0" ]; then echo "volume $path on $svc exists, left alone"; return; fi
  gql 'mutation($i: VolumeCreateInput!){ volumeCreate(input:$i){ id } }' "$(jq -nc --arg p "$PID" --arg e "$EID" --arg s "${SID[$svc]}" --arg m "$path" '{i:{projectId:$p,environmentId:$e,serviceId:$s,mountPath:$m}}')" >/dev/null
  echo "volume $path created on $svc"
}

echo "step 2: services"
for s in vta vtc mediator proxy; do ensure_service "$s"; done
ensure_service Redis "$REDIS_IMAGE"

echo "step 3: volumes (at the paths the entrypoints use)"
ensure_volume vta /var/lib/vta
ensure_volume vtc /var/lib/vtc
# the mediator keeps its own identity (its DID, keys and config): without a volume it is a new mediator on every restart
ensure_volume mediator /var/lib/mediator

echo "step 4: variables"
# Redis is private-network only: no public domain, no TCP proxy is ever created here.
case " $CREATED " in *" Redis "*) set_vars Redis "REDIS_URL=redis://Redis.railway.internal:6379";; esac
case " $CREATED " in *" mediator "*) set_vars mediator 'DATABASE_URL=${{Redis.REDIS_URL}}';; esac   # mediator reads DATABASE_URL (block 10768)
case " $CREATED " in *" proxy "*) set_vars proxy "VTC_UPSTREAM=vtc.railway.internal:8200" "VTA_UPSTREAM=vta.railway.internal:8100" "MEDIATOR_UPSTREAM=mediator.railway.internal:7037";; esac
UNSEALED=""
gen() { openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48; }   # 48 chars of [A-Za-z0-9], well over 128 bits
if case " $CREATED " in *" vta "*) true;; *) false;; esac; then
  p=$(gen); echo "::add-mask::$p"; set_vars vta "VTA_SEED_PASSPHRASE=$p"; unset p; UNSEALED="$UNSEALED VTA_SEED_PASSPHRASE"
fi
if case " $CREATED " in *" vtc "*) true;; *) false;; esac; then
  p=$(gen); echo "::add-mask::$p"; set_vars vtc "VTC_SECRETS_PASSPHRASE=$p"; unset p; UNSEALED="$UNSEALED VTC_SECRETS_PASSPHRASE"
fi
# A passphrase is only ever made together with its service: an existing service keeps what it has (a sealed value cannot be read back, so it is never overwritten).

echo "step 5: the proxy's public domain (port 8080); no other service gets one"
dom=$(gql 'query($p:String!,$e:String!,$s:String!){ domains(projectId:$p,environmentId:$e,serviceId:$s){ serviceDomains { domain } } }' "$(jq -nc --arg p "$PID" --arg e "$EID" --arg s "${SID[proxy]}" '{p:$p,e:$e,s:$s}')" | jq -r '.domains.serviceDomains|length')
if [ "$dom" = "0" ]; then
  gql 'mutation($i: ServiceDomainCreateInput!){ serviceDomainCreate(input:$i){ domain } }' "$(jq -nc --arg e "$EID" --arg s "${SID[proxy]}" '{i:{environmentId:$e,serviceId:$s,targetPort:8080}}')" >/dev/null
  echo "proxy domain created"
else echo "proxy already has a domain, left alone"; fi

echo "done. created this run:${CREATED:- nothing}"
LEFT=""; for s in vta vtc mediator proxy Redis; do case " $CREATED " in *" $s "*) ;; *) LEFT="$LEFT $s";; esac; done
[ -z "$LEFT" ] || echo "::warning::existing and left alone this run:$LEFT. A run that died after creating a service may have left its variables unset: check vta's VTA_SEED_PASSPHRASE, vtc's VTC_SECRETS_PASSPHRASE, mediator's DATABASE_URL and proxy's three *_UPSTREAM values are present (a missing passphrase stops the service at start, loudly)"
[ -z "$UNSEALED" ] || echo "not yet sealed:$UNSEALED  (seal each in the Railway dashboard, 3-dot menu, Seal, BEFORE DNS points at the host)"
