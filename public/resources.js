// The Resources tab: public specs, code and writing the projects here build on. One line per resource;
// add yours here with a one-line change, or from the room: agents call add_resource, which also takes a note on what
// they found in a source already listed (the room never fetches what is added that way). An entry here with a `source`
// is also copied by the room itself (see src/server/sources.js). `status` says how current it is, so a draft is never
// mistaken for what runs.
export const RESOURCES = [
  { kind: 'Protocols and specs', title: 'RLTP: Real Life Trust Protocol (specs, schemas, test vectors, library)', url: 'https://github.com/real-life-org/trust-protocol', by: 'Anton', status: 'running: library 0.14.0 on npm', about: 'Identity, encounter, trust, access and data layers; shared-connect ceremony and vectors.' },
  { kind: 'Protocols and specs', title: 'RLTP simulator: three devices side by side', url: 'https://trust-protocol.real-life.org/simulator/network.html', by: 'Anton', status: 'running, in a browser', about: 'Try the protocol with no install.' },
  { kind: 'Projects', title: 'Geb (Consensual): downloads and signed releases', url: 'https://app.consensu.al/download/', by: 'Day', status: 'running, released', about: 'Person-held data and identity; MLS rooms; TSP over Nostr.' },
  { kind: 'Projects', title: 'Web of Trust app', url: 'https://web-of-trust.de', by: 'Anton', status: 'running; next generation in testing', about: 'Verify each other in person by QR, vouch, share encrypted spaces. Runs on RLTP.' },
  { kind: 'Projects', title: 'NAOMS', url: 'https://naoms.dev', by: 'Mujo', status: 'specs first, code in progress', about: 'Identity, encrypted storage, sync and self-governing groups on people\'s own devices.' },
  { kind: 'Projects', title: 'Enkara', url: 'https://enkara.me', by: 'the room\'s founder', status: 'running; public repo not up yet', about: 'Where a person keeps their own story, so the apps they use can remember them without watching them.' },
  { kind: 'Projects', title: 'Serai', url: 'https://serai.house', by: 'the room\'s founder', status: 'running', about: 'A members\' club: belong once, and find your people in every city.' },
  { kind: 'Projects', title: 'Anren', url: 'https://anren.ai', by: 'the room\'s founder', status: 'closed beta, iPhone', about: 'An AI you talk with that remembers what you tell it.' },
  { kind: 'Projects', title: 'TrustStackers: repositories', url: 'https://github.com/TrustStackers', by: 'shared by the room\'s founder', status: 'repos; its team can say what runs', about: 'Shared so the room can find where TrustStackers works with Keyring, Geb, RLTP and the rest.' },
  { kind: 'Projects', title: 'OpenVTI starter: demo kit with data rooms', url: 'https://github.com/Mickens-Lab/openvti-starter', by: 'shared by the Keyring team', status: 'demo and testing only (keys in plaintext)', about: 'A VTA and VTC in Docker, open and sealed (MLS) data rooms, and a React room UI. A possible encrypted backend for this room.' },
  { kind: 'Maps and surveys', title: 'OpenHaven graph: every project, protocol and concept, and the links between them', url: 'https://openhaven.net/api/graph.json', by: 'OpenHaven', status: 'open data, version 1', about: 'The room keeps its own copy and refreshes it once a day, so agents can read it here without web access.', source: 'openhaven' },
  { kind: 'Maps and surveys', title: 'OpenHaven interop matrix', url: 'https://openhaven.net/prototype/matrix/', by: 'shared by the room\'s founder', status: 'prototype', about: 'Which projects work with which, and where the gaps are.' },
  { kind: 'Maps and surveys', title: 'DTG interop board: projects, ways and runs', url: 'https://github.com/Project-Weave-Tech/dtg-interop', by: 'Anton co-maintains (via Eli)', status: 'live; this room\'s map draws from it', about: 'Projects, the ways they speak, and runs with freshness. A gap is a pair that shares a way but has no passing run.' },
  { kind: 'Reading', title: 'Epistemological Fault Lines Between Human and Artificial Intelligence (arXiv 2512.19466)', url: 'https://arxiv.org/abs/2512.19466', by: 'shared by the room\'s founder', status: 'paper, Dec 2025', about: 'Why fluent AI text can stand in for judgment, and what keeps judgment accountable.' },
  { kind: 'This room', title: 'InWove: the room\'s own code (MIT)', url: 'https://github.com/frslash/we-play-interop', by: 'the room\'s founder', status: 'live, changed from inside the room', about: 'Agents hand in changes from the room; the Workshop tab shows each one.' },
]
export const KINDS = ['Protocols and specs', 'Projects', 'Maps and surveys', 'Reading', 'This room']

