'use strict';
// Recommended day-of tasks for each functional team's captain(s).
//
// Sources: "venue deck.html" (slide: 5 Day-of Functional Teams, hi-vis vests
// for parking/traffic only, 21+ protocol, waste stations) and the 9/28 Circuit Launch
// venue run sheet (7:00 AM volunteer call, check-in 9:00-10:45, boxed lunch
// 11:45-1:00, coffee 2:30-2:55, Awards & After Party + 21+ bar 6:30-9:00,
// teardown 9:00-10:00 PM). Chair/table moves and tent installs are handled by
// the Bay Area Event Rentals crew, so no template asks volunteers to haul
// furniture. Times are 24h "HH:MM" on event day (Thu Oct 1) and editable.
//
// Seeding is idempotent: a seeded task's id is derived from the role and the
// template key, so seeding twice (or on two instances at once) never creates
// duplicates, and a seeded task the admin deleted is not recreated.

const KINDS = {
  registration: { label: 'Registration' },
  security: { label: 'Security & Wayfinding' },
  tech: { label: 'Tech Support' },
  food: { label: 'Food & Beverage' },
  cleanup: { label: 'Event Cleanup' }
};

// Same keyword order the volunteer page uses for venue instructions.
function roleKind(title) {
  const t = String(title || '').toLowerCase();
  if (t.includes('registration') || t.includes('check-in')) return 'registration';
  if (t.includes('wayfind') || t.includes('security') || t.includes('parking')) return 'security';
  if (t.includes('tech') || t.includes('av') || t.includes('stage')) return 'tech';
  if (t.includes('food') || t.includes('guest')) return 'food';
  if (t.includes('clean') || t.includes('sweep')) return 'cleanup';
  return null;
}

// Hi-vis vests are for the parking/traffic volunteers only.
function crewCheckIn(extra) {
  return {
    key: 'crew-checkin',
    title: 'Crew check-in and headcount',
    details: `Arrive 15 min early (6:45 AM) at Tent 1 (crew base) for the 7:00 AM volunteer call.${extra ? ' ' + extra : ''} Text the organizer your headcount and any no-shows.`,
    location: 'Tent 1 (crew base)',
    startTime: '06:45',
    endTime: '07:15',
    priority: 'high'
  };
}

const TEMPLATES = {
  registration: [
    crewCheckIn(),
    {
      key: 'stage-checkin',
      title: 'Stage the check-in desk',
      details: 'Rental crew places 2 six-foot tables, 2 chairs and 4 stanchions at the main entrance. Lay out badges, lanyards, 21+ wristbands, swag, pens, and the Circuit Launch waiver QR signs. Queue lane uses the stanchions.',
      location: 'Arrival / Registration (main entrance)',
      startTime: '07:15',
      endTime: '08:30',
      priority: 'normal'
    },
    {
      key: 'test-nfc-waiver',
      title: 'Test NFC badge pairing and waiver QR',
      details: 'Before doors: pair one test NFC badge end to end and complete the Circuit Launch digital waiver from the QR code on two different phones (iOS + Android). Report any failure to the organizer immediately.',
      location: 'Arrival / Registration',
      startTime: '08:30',
      endTime: '09:00',
      priority: 'high'
    },
    {
      key: 'peak-checkin',
      title: 'Run peak check-in (3 volunteers)',
      details: 'For every attendee: NFC badge, signed CL waiver (mandatory), lanyard and swag. 21+ attendees: check photo ID and apply the 21+ wristband. Keep the line moving; send anyone without a registration to the info desk.',
      location: 'Arrival / Registration',
      startTime: '09:00',
      endTime: '10:45',
      priority: 'high'
    },
    {
      key: 'late-checkin',
      title: 'Switch to late check-in and info desk',
      details: 'At 10:45 drop to 1 volunteer and 1 table. Send the 4 stanchions to the Expo interstitial. Info desk stays staffed until 6:30 PM (directions, lost & found, late arrivals).',
      location: 'Arrival / Registration',
      startTime: '10:45',
      endTime: '18:30',
      priority: 'normal'
    },
    {
      key: 'checkin-counts',
      title: 'Report check-in counts',
      details: 'Text the organizer the checked-in total and number of 21+ wristbands at 10:45 AM and again at 6:30 PM.',
      location: 'Arrival / Registration',
      startTime: '10:45',
      endTime: '10:50',
      priority: 'normal'
    },
    {
      key: 'bar-id-check',
      title: '21+ bar: double ID check',
      details: '21+ bar at the Main Entrance during the After Party. Every drink requires a 21+ wristband AND a matching ID check. No wristband, no drink. Works alongside the Food & Beverage pourers.',
      location: 'Main Entrance (21+ bar)',
      startTime: '18:30',
      endTime: '21:00',
      priority: 'high'
    }
  ],

  security: [
    crewCheckIn('Hand the neon yellow hi-vis EVENT STAFF vests and traffic wands to the parking/traffic volunteers only.'),
    {
      key: 'post-signage',
      title: 'Post directional signage',
      details: 'Signs for: Moffett Blvd entrance, registration (Main Entrance tent), restrooms, Main Stage (Rm 109+104), Developer Track (Rm 117), Vibe Lounge (Rm 102), Expo Hall, HQ (Rm 127), and the backyard tents.',
      location: 'Entrances and corridors',
      startTime: '07:15',
      endTime: '08:45',
      priority: 'high'
    },
    {
      key: 'moffett-arrival',
      title: 'Traffic direction at Moffett Blvd (arrival peak)',
      details: 'Two hi-vis volunteers with wands at the Moffett Blvd entrance. The Circuit Launch lot is STRICTLY for speakers, VIPs, ADA and vendor loading; keep the entrance and drive aisles clear.',
      location: 'Moffett Blvd entrance',
      startTime: '08:45',
      endTime: '10:45',
      priority: 'high'
    },
    {
      key: 'door-access',
      title: 'Door access and quiet zones',
      details: 'Monitor facility doors all day. Keep Corridor 120 (rear egress to the tents) clear. Keep attendees out of Circuit Launch member work areas (quiet zones).',
      location: 'Facility doors, Corridor 120',
      startTime: '10:00',
      endTime: '18:45',
      priority: 'normal'
    },
    {
      key: 'main-stage-flow',
      title: 'Main Stage crowd flow',
      details: 'One volunteer at the Main Stage door for each session (opener 10:45, keynote, fireside 2:55, afternoon talks, awards 6:30). ~120 seats plus ~60 standing: keep aisles and exits clear and hold the door when full.',
      location: 'Main Stage (Rm 109/104)',
      startTime: '10:45',
      endTime: '18:45',
      priority: 'normal'
    },
    {
      key: 'evening-door',
      title: 'Evening door monitor and departures',
      details: 'Lobby door monitor during the Awards & After Party. Traffic volunteers (hi-vis) help with departures on Moffett Blvd.',
      location: 'Front lobby / Moffett Blvd',
      startTime: '18:30',
      endTime: '21:00',
      priority: 'normal'
    }
  ],

  tech: [
    crewCheckIn('Grab the AV master key from the Speaker Green Room & HQ (Rm 127).'),
    {
      key: 'main-stage-av',
      title: 'Main Stage AV check',
      details: 'Test every mic (handheld + lav), the presenter screen and clicker, and the AV mixer at the back desk. Play the opener video end to end with sound.',
      location: 'Main Stage (Rm 109/104)',
      startTime: '07:15',
      endTime: '09:30',
      priority: 'high'
    },
    {
      key: 'power-cable-covers',
      title: 'Power strips and cable covers',
      details: 'Laptop power strips in Track 2 (Rm 117) and the Vibe Lounge (Rm 102). Rubber cable covers over EVERY cable run and power drop (trip hazard, and protects CL floors).',
      location: 'Rm 117, Rm 102, Expo Hall',
      startTime: '07:15',
      endTime: '09:30',
      priority: 'high'
    },
    {
      key: 'wifi-check',
      title: 'Wi-Fi check and signs',
      details: 'Test Wi-Fi in Rm 117, Rm 102, Expo Hall and Main Stage. Post the network name/password signs.',
      location: 'All rooms',
      startTime: '09:00',
      endTime: '09:45',
      priority: 'normal'
    },
    {
      key: 'session-timers-recording',
      title: 'Session timers, mic handoffs and recording',
      details: 'For every Main Stage session: start/stop the recording, run the speaker timer, swap mics between speakers. Check recording storage and batteries at each break.',
      location: 'Main Stage AV desk',
      startTime: '10:45',
      endTime: '18:45',
      priority: 'high'
    },
    {
      key: 'lab-support',
      title: 'Hands-On Lab support',
      details: 'Google Cloud Hands-On Lab (seating 12:45, lab 1:00-2:30). Help attendees with laptop power and Wi-Fi; flag blockers to the lab mentors.',
      location: 'Main Stage',
      startTime: '12:45',
      endTime: '14:30',
      priority: 'normal'
    },
    {
      key: 'awards-karaoke-av',
      title: 'Awards AV, then karaoke setup',
      details: 'Awards on the Main Stage at 6:30 (winner slides + mics), then switch the Main Stage audio to karaoke for the After Party.',
      location: 'Main Stage (Rm 109+104)',
      startTime: '18:15',
      endTime: '19:00',
      priority: 'normal'
    },
    {
      key: 'av-teardown',
      title: 'AV teardown and return the master key',
      details: 'Coil and pack all AV and power drops, and return the AV master key to HQ (Rm 127).',
      location: 'Main Stage, HQ (Rm 127)',
      startTime: '21:00',
      endTime: '22:00',
      priority: 'normal'
    }
  ],

  food: [
    crewCheckIn(),
    {
      key: 'ice-cooler',
      title: 'Fill the CL cooler and ice tubs',
      details: 'Stock the Circuit Launch large cooler and the organizer ice tubs. Check ice every hour and refill before it runs out.',
      location: 'Food canopy / rear lot',
      startTime: '07:30',
      endTime: '08:30',
      priority: 'normal'
    },
    {
      key: 'breakfast',
      title: 'Breakfast buffet',
      details: 'Set and serve breakfast burritos, hot coffee, tea and juice at the food canopy. Keep the line moving and restock.',
      location: 'Food canopy (Canopy B), Tent 2 seating',
      startTime: '08:30',
      endTime: '10:45',
      priority: 'high'
    },
    {
      key: 'coffee-water',
      title: 'Keep coffee and water stations full',
      details: 'Walk all coffee/water stations every hour; refill and restock cups.',
      location: 'All stations',
      startTime: '09:00',
      endTime: '18:30',
      priority: 'normal'
    },
    {
      key: 'boxed-lunch',
      title: 'Boxed lunch distribution',
      details: 'Hand out boxed lunches during the vendor showcase. Track how many were handed out and report the count to the organizer.',
      location: 'Expo Hall',
      startTime: '11:45',
      endTime: '13:00',
      priority: 'high'
    },
    {
      key: 'coffee-break',
      title: 'Afternoon coffee and snack break',
      details: 'Afternoon snacks, cold brew and sparkling water for the break.',
      location: 'Expo Hall',
      startTime: '14:30',
      endTime: '14:55',
      priority: 'normal'
    },
    {
      key: 'afterparty-food',
      title: 'Afterparty quesadillas and drinks',
      details: 'Serve quesadillas and non-alcoholic beverages at the food canopy during the After Party.',
      location: 'Food canopy',
      startTime: '18:30',
      endTime: '21:00',
      priority: 'normal'
    },
    {
      key: 'bar-service',
      title: '21+ single-pour bar',
      details: 'TIPS-trained volunteers only pour, single servings (beer/wine/cider). Verify the 21+ wristband for every drink (double ID check with Registration). No self-service, no glass in the workshop corridors.',
      location: 'Main Entrance (21+ bar)',
      startTime: '18:30',
      endTime: '21:00',
      priority: 'high'
    }
  ],

  cleanup: [
    crewCheckIn(),
    {
      key: 'waste-stations',
      title: 'Set up 4 waste sorting stations',
      details: 'Four multi-stream stations (compost / recycle / landfill) with signs: Expo Hall, Tent 2, food canopy, and near Main Stage. Stock spare bags at each.',
      location: 'Expo Hall, Tent 2, food canopy, Main Stage',
      startTime: '07:15',
      endTime: '08:45',
      priority: 'high'
    },
    {
      key: 'hourly-sweeps',
      title: 'Hourly sweeps',
      details: 'Every hour: replace full bags, wipe tables, pick up litter in rooms, corridors and tents. Nothing should overflow.',
      location: 'All areas',
      startTime: '09:00',
      endTime: '21:00',
      priority: 'high'
    },
    {
      key: 'post-breakfast',
      title: 'Post-breakfast reset',
      details: 'Clear and wipe Tent 2 tables and the breakfast area once service ends.',
      location: 'Tent 2, food canopy',
      startTime: '10:45',
      endTime: '11:15',
      priority: 'normal'
    },
    {
      key: 'post-lunch',
      title: 'Post-lunch reset',
      details: 'Collect lunch boxes and trash from the Expo Hall and Tent 2; empty the sorting stations.',
      location: 'Expo Hall, Tent 2',
      startTime: '13:00',
      endTime: '13:30',
      priority: 'normal'
    },
    {
      key: 'pre-awards',
      title: 'Sanitize tables before awards and afterparty',
      details: 'Wipe high-tops and tables in the Expo Hall, Tent 2 and Vibe Lounge before the 6:30 awards.',
      location: 'Expo Hall, Tent 2, Rm 102',
      startTime: '18:15',
      endTime: '18:45',
      priority: 'normal'
    },
    {
      key: 'final-handoff',
      title: 'Final trash-out and handoff',
      details: 'Bag and remove all trash, pull event signage, vacuum common areas. Chair stacking, table folding and tent strikes are done by the rental crew: do not lift furniture. Walk the building with the organizer for the Circuit Launch handoff.',
      location: 'Whole facility',
      startTime: '21:00',
      endTime: '22:00',
      priority: 'high'
    }
  ]
};

function templatesForTitle(title) {
  const kind = roleKind(title);
  return kind ? TEMPLATES[kind] : [];
}

function seedTaskId(roleId, key) {
  return `seed_${String(roleId).replace(/[^A-Za-z0-9_-]/g, '')}_${key}`;
}

module.exports = { KINDS, TEMPLATES, roleKind, templatesForTitle, seedTaskId };
