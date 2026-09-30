'use strict';
// Recommended instructions for every instruction target, from the Circuit
// Launch venue plan and the final agenda (Thu Oct 1, 2026). Admins can load
// these from the admin page and edit them afterwards.
//
// Deliberately NOT mentioned: the Google overflow lots / shuttle (proposed,
// not confirmed).

const ROLE_IDS = {
  registration: 'MAAAAAEPa5hl',
  security: 'MAAAAAEQvpZa',
  tech: 'MAAAAAEPa5hz',
  food: 'MAAAAAEPa5hq',
  cleanup: 'MAAAAAEPa5hu'
};

const GLOBAL = [
  'DevFest Bay Area 2026 · Thu Oct 1 · Circuit Launch, 599 Fairchild Drive, Mountain View. Event 9:00 AM–9:00 PM.',
  '• Volunteer call 7:00 AM at Tent 1 (crew base, north lot). Pre-setup crew: Wed Sept 30, 9–11 PM.',
  '• Check-in & breakfast 9:00–10:45 AM at the Main Entrance tent; building doors open 10:00 AM. No badge, no building entry.',
  '• Rooms: Main Stage = Rm 109+104 · Developer Track = Rm 117 · Builder Track / Vibe Lounge = Rm 102 · Expo Hall open 10:00 AM–6:30 PM · Speaker Green Room & HQ = Rm 127.',
  '• Awards & After Party 6:30–9:00 PM on the Main Stage (Expo Hall, Vibe Lounge & Outdoor Lounge also open). 21+ bar at the Main Entrance.',
  '• Teardown 9:00–10:00 PM: every team stays until the building is handed back.',
  '• Your captain is your first contact; if you cannot find them, go to HQ (Rm 127). Hi-vis vests are for parking/traffic volunteers only.'
].join('\n');

const ROLES = {
  registration: [
    'Team 1 · Registration (4) · Main Entrance tent.',
    '• Stage the check-in desks from 7:15 AM. Before 9:00, test NFC badge pairing and the Circuit Launch waiver QR on an iPhone and an Android phone.',
    '• Check-in 9:00–10:45 AM (doors open 10:00): every attendee signs the Circuit Launch digital liability waiver (QR) before getting a badge and lanyard. Pair the NFC badge, hand out swag.',
    '• 21+: check photo ID and apply the wristband at check-in.',
    '• After 10:45, one person stays on late check-in / info desk.',
    '• Evening: support the 21+ bar ID check at the Main Entrance, 6:30–9:00 PM. Teardown 9–10 PM.'
  ].join('\n'),
  security: [
    'Team 2 · Security & Wayfinding (5).',
    '• Post directional signs by 8:45 AM: Main Stage (Rm 109+104), Developer Track (Rm 117), Vibe Lounge (Rm 102), Expo Hall, HQ (Rm 127), restrooms, tents.',
    '• Two traffic volunteers at the Moffett Blvd entrance 8:45–10:45 AM and 6:30–9:00 PM. Only they wear the hi-vis vests.',
    '• The Circuit Launch lot is reserved for speakers, VIPs, ADA and vendor loading.',
    '• All day: watch the doors, keep exits clear, keep guests out of Circuit Launch member quiet zones, and hold the Main Stage door when it is full (~120 seats + standing).',
    '• Teardown 9–10 PM.'
  ].join('\n'),
  tech: [
    'Team 3 · Tech Support (10).',
    '• By 9:30 AM: Main Stage (Rm 109+104) mic, screen and opener-video check; power strips and cable covers in Rm 117, Rm 102 and the Expo Hall.',
    '• From 10:45: mics, timers and recording for every Main Stage session.',
    '• 11:45 AM–12:45 PM: turn the Main Stage into a ~90-seat laptop lab. Support the Cloud Run hands-on lab 1:00–2:30, then reset to theater seating 2:30–3:00.',
    '• Dev Challenge 3:00–5:15 and judging 5:15–6:15 in Rm 117: keep power and Wi-Fi solid there.',
    '• Awards AV at 6:30 PM on the Main Stage. AV teardown 9–10 PM. Report problems to HQ (Rm 127).'
  ].join('\n'),
  food: [
    'Team 4 · Food & Beverage (3).',
    '• Check-in breakfast 9:00–10:45 AM at the Main Entrance tent.',
    '• Boxed lunch 11:45 AM–1:00 PM and coffee & snack break 2:30–2:55 PM in the Expo Hall. Keep water and coffee stocked all day, and keep the Circuit Launch cooler and ice tubs full.',
    '• After Party 6:30–9:00 PM: food from the food canopy. 21+ single-pour bar at the Main Entrance: TIPS-trained pourers only, single servings of beer/wine/cider, wristband + ID check for every drink.',
    '• Help reset 9–10 PM.'
  ].join('\n'),
  cleanup: [
    'Team 5 · Event Cleanup (3).',
    '• Set up the waste sorting stations before doors open, then do hourly sweeps: swap full bags, wipe tables, pick up litter in rooms, corridors and tents.',
    '• Resets after breakfast (10:45), after lunch (1:00) and before Awards (6:15).',
    '• Support Tech on the Main Stage turnovers, 11:45–12:45 and 2:30–3:00.',
    '• Teardown 9–10 PM: final trash-out, pull signage, sweep, then walk the building with the organizer for the 10:00 PM handoff.'
  ].join('\n')
};

const JUDGES = [
  'Judges · DevFest Bay Area 2026 · Circuit Launch.',
  '• Gemini Dev Challenge runs 3:00–5:15 PM; submissions close at 5:15.',
  '• Dev Challenge judging 5:15–6:15 PM in Rm 117 (Developer Track) with Parul Gupta + Google Experts.',
  '• Each team gets 5 minutes: 2-min demo, 2-min Q&A, 1-min transition. Enter your score in the Judge Portal during the transition (5 criteria × 10 pts = 50).',
  '• The Builder Track Prototype Showcase runs 5:15–6:15 PM in the Expo Hall.',
  '• Check in at the Speaker Green Room & HQ (Rm 127) when you arrive. Winners are announced at Awards, 6:30 PM on the Main Stage.'
].join('\n');

// target -> text, in the shape POST /api/instructions expects.
function recommendedInstructions() {
  const out = { global: GLOBAL, judges: JUDGES };
  for (const [kind, id] of Object.entries(ROLE_IDS)) out['role_' + id] = ROLES[kind];
  return out;
}

// Short built-in venue note shown on each role card of the volunteer page.
const VENUE_NOTES = {
  registration: '📍 **Main Entrance tent:** Check-in & breakfast 9:00–10:45 AM (doors open 10:00). Every attendee signs the Circuit Launch digital waiver (QR) before getting a badge. NFC badge pairing, 21+ wristbands, swag.',
  security: '📍 **Security & Wayfinding:** Signage, door monitoring and crowd flow. Traffic volunteers at the Moffett Blvd entrance wear the hi-vis vests. The Circuit Launch lot is reserved for speakers, VIPs, ADA and vendor loading.',
  tech: '📍 **Tech / AV:** Main Stage (Rm 109+104) AV and recording, laptop lab turnover 11:45 AM–12:45 PM, Developer Track (Rm 117) power and Wi-Fi.',
  food: '📍 **Food:** Breakfast at the Main Entrance tent, lunch and coffee break in the Expo Hall, After Party food canopy. 21+ single-pour bar at the Main Entrance with a double ID check.',
  cleanup: '📍 **Cleanup:** Hourly sweeps to swap bags and wipe tables. Teardown 9:00–10:00 PM with full facility handoff by 10:00 PM.'
};

module.exports = { ROLE_IDS, recommendedInstructions, VENUE_NOTES };
